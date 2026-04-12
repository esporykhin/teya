/**
 * @description OpenRouter LLM provider (OpenAI-compatible API, all cloud models)
 * @exports openrouter
 */
import type {
  LLMProvider,
  GenerateRequest,
  GenerateOptions,
  GenerateResponse,
  StreamChunk,
  ToolCall,
  ToolDefinition,
  Message,
  ProviderCapabilities,
  GenerationDetails,
  TransportMetrics,
} from '@teya/core'
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ─── OpenRouter models cache (pricing + context) ─────────────────────────────
// Cached on disk so we have real costs from the very first request after the
// first successful fetch. Background-refreshed when stale.

interface ORModel {
  id: string
  pricing?: { prompt?: string; completion?: string }
  context_length?: number
  top_provider?: { max_completion_tokens?: number }
}

const MODELS_CACHE_FILE = join(homedir(), '.teya', 'openrouter-models.json')
const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000

let cachedModels: Map<string, ORModel> | null = null
let refreshInFlight: Promise<void> | null = null

function loadModelsCacheSync(): { models: Map<string, ORModel> | null; mtimeMs: number } {
  try {
    const stat = statSync(MODELS_CACHE_FILE)
    const data = JSON.parse(readFileSync(MODELS_CACHE_FILE, 'utf-8')) as ORModel[]
    return { models: new Map(data.map(m => [m.id, m])), mtimeMs: stat.mtimeMs }
  } catch {
    return { models: null, mtimeMs: 0 }
  }
}

async function refreshModelsCache(): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/models')
      if (!r.ok) return
      const json = (await r.json()) as { data: ORModel[] }
      mkdirSync(join(homedir(), '.teya'), { recursive: true })
      writeFileSync(MODELS_CACHE_FILE, JSON.stringify(json.data), 'utf-8')
      cachedModels = new Map(json.data.map(m => [m.id, m]))
    } catch {
      // network failure — keep whatever we had
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

function applyModelInfo(capabilities: ProviderCapabilities, info: ORModel | undefined): void {
  if (!info) return
  const promptPrice = Number(info.pricing?.prompt ?? '0')
  const completionPrice = Number(info.pricing?.completion ?? '0')
  if (Number.isFinite(promptPrice) && promptPrice > 0) capabilities.costPerInputToken = promptPrice
  if (Number.isFinite(completionPrice) && completionPrice > 0) capabilities.costPerOutputToken = completionPrice
  if (info.context_length && info.context_length > 0) capabilities.maxContextTokens = info.context_length
  const maxOut = info.top_provider?.max_completion_tokens
  if (maxOut && maxOut > 0) capabilities.maxOutputTokens = maxOut
}

// ─── OpenAI-compatible wire types ────────────────────────────────────────────

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OAIToolCall[]
  tool_call_id?: string
  name?: string
}

interface OAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface OAIResponse {
  id: string
  model: string
  choices: Array<{
    message: {
      role: string
      content: string | null
      tool_calls?: OAIToolCall[]
    }
    finish_reason: string
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    /** OpenRouter / OpenAI cached prompt tokens. */
    prompt_tokens_details?: { cached_tokens?: number }
    /** Reasoning tokens for o1/r1-style models. */
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

interface OAIStreamDelta {
  id: string
  model: string
  choices: Array<{
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function toOAIMessages(messages: Message[], systemPrompt?: string): OAIMessage[] {
  const result: OAIMessage[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (msg.role === 'tool') {
      result.push({
        role: 'tool',
        content: msg.content,
        tool_call_id: msg.toolCallId,
        name: msg.name,
      })
    } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      result.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        })),
      })
    } else if (msg.images && msg.images.length > 0) {
      // Multimodal message — text + images
      const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
      if (msg.content) {
        parts.push({ type: 'text', text: msg.content })
      }
      for (const img of msg.images) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.data}` },
        })
      }
      result.push({
        role: msg.role as OAIMessage['role'],
        content: parts as any,
      })
    } else {
      result.push({
        role: msg.role as OAIMessage['role'],
        content: msg.content,
      })
    }
  }

  return result
}

function toOAITools(tools: ToolDefinition[]): OAITool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

function mapFinishReason(reason: string): GenerateResponse['finishReason'] {
  switch (reason) {
    case 'tool_calls':
      return 'tool_calls'
    case 'length':
      return 'length'
    case 'stop':
    default:
      return 'stop'
  }
}

function parseToolCalls(oaiToolCalls?: OAIToolCall[]): ToolCall[] | undefined {
  if (!oaiToolCalls || oaiToolCalls.length === 0) return undefined
  return oaiToolCalls.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    args: parseToolArguments(tc.function.arguments),
  }))
}

/**
 * Robust tool argument parser. Handles:
 * - Valid JSON string → parse normally
 * - Already an object (some models return object, not string) → return as-is
 * - Truncated JSON → attempt repair (close braces/brackets)
 * - Invalid JSON with unescaped content → extract key-value pairs
 * - Complete failure → return { _raw } as last resort
 */
function parseToolArguments(raw: unknown): Record<string, unknown> {
  // Already an object (Gemini sometimes does this)
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }

  if (typeof raw !== 'string' || raw.trim() === '') {
    return {}
  }

  const str = raw.trim()

  // 1. Try normal parse
  try {
    const parsed = JSON.parse(str)
    if (typeof parsed === 'object' && parsed !== null) return parsed
    return { value: parsed }
  } catch {
    // continue to repair attempts
  }

  // 2. Try repairing truncated JSON (missing closing braces)
  try {
    let repaired = str
    const opens = (repaired.match(/{/g) || []).length
    const closes = (repaired.match(/}/g) || []).length
    // Close unclosed strings — find if there's an unterminated quote
    const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length
    if (quoteCount % 2 !== 0) repaired += '"'
    // Close unclosed braces
    for (let i = 0; i < opens - closes; i++) repaired += '}'
    // Close unclosed brackets
    const openBrackets = (repaired.match(/\[/g) || []).length
    const closeBrackets = (repaired.match(/]/g) || []).length
    for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']'

    const parsed = JSON.parse(repaired)
    if (typeof parsed === 'object' && parsed !== null) return parsed
  } catch {
    // continue
  }

  // 3. Try extracting from partial JSON — look for "key": "value" patterns
  try {
    const pairs: Record<string, unknown> = {}
    // Match "key": "value" or "key": number or "key": true/false
    const regex = /"(\w+)"\s*:\s*("(?:[^"\\]|\\.)*"|[\d.]+|true|false|null)/g
    let match
    while ((match = regex.exec(str)) !== null) {
      const key = match[1]
      const rawVal = match[2]
      if (rawVal.startsWith('"')) {
        pairs[key] = rawVal.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
      } else if (rawVal === 'true') pairs[key] = true
      else if (rawVal === 'false') pairs[key] = false
      else if (rawVal === 'null') pairs[key] = null
      else pairs[key] = Number(rawVal)
    }
    if (Object.keys(pairs).length > 0) return pairs
  } catch {
    // continue
  }

  // 4. Last resort — return raw string so tools can at least see the data
  return { _raw: str }
}

// ── Retry logic ──────────────────────────────────────────────────────────────

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 520, 521, 522, 523, 524])
const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000

interface FetchWithRetryResult {
  response: Response
  retryCount: number
  /** Time-to-first-byte for the FINAL successful attempt (ms from POST start). */
  ttfbMs: number
  /** Wall-clock for the final successful attempt only. */
  attemptStartMs: number
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<FetchWithRetryResult> {
  let lastError: Error | null = null
  let retryCount = 0

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Request aborted')

    try {
      const attemptStartMs = Date.now()
      const response = await fetch(url, { ...init, signal })
      // TTFB = headers received. fetch() resolves at headers, body still streaming.
      const ttfbMs = Date.now() - attemptStartMs

      // Success or non-retryable error — return immediately
      if (response.ok || !RETRYABLE_STATUS.has(response.status)) {
        return { response, retryCount, ttfbMs, attemptStartMs }
      }

      // Retryable status — read error for logging, then retry
      const errorText = await response.text().catch(() => '')
      lastError = new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`)

      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500
        retryCount++
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    } catch (err) {
      lastError = err as Error
      if (signal?.aborted) throw lastError

      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500
        retryCount++
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError || new Error('Request failed after retries')
}

// ─── Provider factory ─────────────────────────────────────────────────────────

export function openrouter(config: {
  model: string
  apiKey: string
  baseUrl?: string
}): LLMProvider {
  const baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1'
  const endpoint = `${baseUrl}/chat/completions`

  const capabilities: ProviderCapabilities = {
    toolCalling: true,
    parallelToolCalls: true,
    streaming: true,
    vision: true,
    jsonMode: true,
    maxContextTokens: 200000,
    maxOutputTokens: 8192,
    costPerInputToken: 0,
    costPerOutputToken: 0,
  }

  // Hydrate capabilities from cached OpenRouter /models data. The tracer holds
  // a reference to this object, so background updates take effect live.
  let cacheMtime = 0
  if (!cachedModels) {
    const loaded = loadModelsCacheSync()
    cachedModels = loaded.models
    cacheMtime = loaded.mtimeMs
  } else {
    try { cacheMtime = statSync(MODELS_CACHE_FILE).mtimeMs } catch {}
  }
  applyModelInfo(capabilities, cachedModels?.get(config.model))

  const cacheStale = !cacheMtime || Date.now() - cacheMtime > MODELS_CACHE_TTL_MS
  if (cacheStale) {
    refreshModelsCache().then(() => applyModelInfo(capabilities, cachedModels?.get(config.model)))
  }

  async function generate(
    request: GenerateRequest,
    options?: GenerateOptions,
  ): Promise<GenerateResponse> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: toOAIMessages(request.messages, request.systemPrompt),
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 4096,
      stream: false,
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = toOAITools(request.tools)
    }

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' }
    }

    if (request.stop && request.stop.length > 0) {
      body.stop = request.stop
    }

    const requestBodyText = JSON.stringify(body)
    const requestBytes = Buffer.byteLength(requestBodyText, 'utf-8')
    const httpStartMs = Date.now()

    const { response, retryCount, ttfbMs, attemptStartMs } = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://teya.dev',
      },
      body: requestBodyText,
    }, options?.signal)

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable>')
      throw new Error(`OpenRouter HTTP ${response.status}: ${errorText}`)
    }

    const responseBodyText = await response.text()
    const httpLatencyMs = Date.now() - attemptStartMs
    const responseBytes = Buffer.byteLength(responseBodyText, 'utf-8')

    const data = JSON.parse(responseBodyText) as OAIResponse
    const choice = data.choices[0]
    const message = choice.message
    const cachedInputTokens = data.usage.prompt_tokens_details?.cached_tokens
    const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens

    const transport: TransportMetrics = {
      httpLatencyMs,
      ttfbMs,
      requestBytes,
      responseBytes,
      statusCode: response.status,
    }

    return {
      content: message.content ?? '',
      toolCalls: parseToolCalls(message.tool_calls),
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      },
      model: data.model,
      finishReason: mapFinishReason(choice.finish_reason),
      generationId: data.id,
      retryCount,
      transport,
      providerMetadata: { configuredModel: config.model, totalWallMs: Date.now() - httpStartMs },
    }
  }

  // ── getGenerationDetails — pulls authoritative billing from OpenRouter ─────
  // Endpoint: GET https://openrouter.ai/api/v1/generation?id=<id>
  // Real response shape (verified 2026-04):
  //   data: {
  //     usage: 0.00253,                       // <-- USD cost
  //     native_tokens_prompt / completion / cached / reasoning,
  //     generation_time: 1900,                // ms
  //     provider_responses: [{ provider_name: 'Alibaba', latency: 1227, ... }],
  //     finish_reason, ...
  //   }
  // Best-effort: any failure resolves to null so tracing never breaks the agent.
  async function getGenerationDetails(generationId: string): Promise<GenerationDetails | null> {
    try {
      const url = `${baseUrl}/generation?id=${encodeURIComponent(generationId)}`
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      })
      if (!r.ok) return null
      const json = (await r.json()) as { data?: Record<string, unknown> }
      const d = json.data
      if (!d) return null

      const num = (k: string): number | undefined => {
        const v = d[k]
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined
      }

      const providerResponses = d['provider_responses'] as Array<Record<string, unknown>> | undefined
      const firstProvider = providerResponses?.[0]
      const providerName = typeof firstProvider?.['provider_name'] === 'string'
        ? (firstProvider['provider_name'] as string)
        : undefined

      return {
        generationId,
        actualCostUsd: num('usage') ?? num('total_cost'),
        cachedInputTokens: num('native_tokens_cached'),
        latencyMs: num('generation_time') ?? num('latency'),
        providerName,
        raw: d,
      }
    } catch {
      return null
    }
  }

  async function* stream(
    request: GenerateRequest,
    options?: GenerateOptions,
  ): AsyncGenerator<StreamChunk> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: toOAIMessages(request.messages, request.systemPrompt),
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = toOAITools(request.tools)
    }

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' }
    }

    if (request.stop && request.stop.length > 0) {
      body.stop = request.stop
    }

    const { response } = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://teya.dev',
      },
      body: JSON.stringify(body),
    }, options?.signal)

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable>')
      throw new Error(`OpenRouter HTTP ${response.status}: ${errorText}`)
    }

    if (!response.body) {
      throw new Error('OpenRouter: response body is null (streaming)')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // Accumulate partial tool call arguments keyed by index
    const toolCallAccumulator: Map<
      number,
      { id: string; name: string; argumentsChunks: string[] }
    > = new Map()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue

          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') {
            yield { type: 'done' }
            return
          }

          let chunk: OAIStreamDelta
          try {
            chunk = JSON.parse(payload) as OAIStreamDelta
          } catch {
            continue
          }

          const choice = chunk.choices?.[0]
          if (!choice) continue

          const delta = choice.delta

          // Text content
          if (delta.content) {
            yield { type: 'content_delta', text: delta.content }
          }

          // Tool call deltas
          if (delta.tool_calls) {
            for (const tcDelta of delta.tool_calls) {
              const idx = tcDelta.index

              if (!toolCallAccumulator.has(idx)) {
                toolCallAccumulator.set(idx, {
                  id: tcDelta.id ?? '',
                  name: tcDelta.function?.name ?? '',
                  argumentsChunks: [],
                })
              }

              const acc = toolCallAccumulator.get(idx)!

              if (tcDelta.id) acc.id = tcDelta.id
              if (tcDelta.function?.name) acc.name = tcDelta.function.name
              if (tcDelta.function?.arguments) {
                acc.argumentsChunks.push(tcDelta.function.arguments)
              }

              yield {
                type: 'tool_call_delta',
                toolCall: {
                  id: acc.id,
                  name: acc.name,
                },
              }
            }
          }

          // Usage (some providers send it on last chunk)
          if (chunk.usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
                totalTokens: chunk.usage.total_tokens,
              },
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    yield { type: 'done' }
  }

  return {
    name: `openrouter:${config.model}`,
    type: 'openrouter',
    capabilities,
    generate,
    stream,
    getGenerationDetails,
  }
}
