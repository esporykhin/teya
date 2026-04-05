/**
 * @description Ollama provider for local models
 * @exports ollama
 */
import type {
  LLMProvider,
  GenerateRequest,
  GenerateOptions,
  GenerateResponse,
  StreamChunk,
  ToolCall,
  Message,
  ProviderCapabilities,
} from '@teya/core'

// ─── Ollama wire types ────────────────────────────────────────────────────────

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
}

interface OllamaToolCall {
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

interface OllamaRequest {
  model: string
  messages: OllamaMessage[]
  tools?: OllamaTool[]
  stream: boolean
  options?: {
    temperature?: number
    num_predict?: number
    stop?: string[]
  }
}

interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface OllamaResponse {
  model: string
  message: {
    role: string
    content: string
    tool_calls?: OllamaToolCall[]
  }
  done: boolean
  eval_count?: number
  prompt_eval_count?: number
}

interface OllamaStreamChunk {
  model: string
  message: {
    role: string
    content: string
  }
  done: boolean
  eval_count?: number
  prompt_eval_count?: number
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function toOllamaMessages(messages: Message[], systemPrompt?: string): OllamaMessage[] {
  const result: OllamaMessage[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (msg.role === 'tool') {
      // Ollama doesn't have a separate tool role — fold into user message
      result.push({
        role: 'user',
        content: `Tool result: ${msg.content}`,
      })
    } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      result.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.toolCalls.map((tc) => ({
          function: {
            name: tc.name,
            arguments: tc.args,
          },
        })),
      })
    } else {
      result.push({
        role: msg.role as OllamaMessage['role'],
        content: msg.content,
      })
    }
  }

  return result
}

function parseOllamaToolCalls(
  toolCalls: OllamaToolCall[] | undefined,
): ToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined
  return toolCalls.map((tc, index) => ({
    id: `call_${index}_${Date.now()}`,
    name: tc.function.name,
    args: tc.function.arguments,
  }))
}

// ─── Provider factory ─────────────────────────────────────────────────────────

export function ollama(config: {
  model: string
  baseUrl?: string
  toolCalling?: boolean
}): LLMProvider {
  const baseUrl = config.baseUrl ?? 'http://localhost:11434'
  const endpoint = `${baseUrl}/api/chat`

  const capabilities: ProviderCapabilities = {
    toolCalling: config.toolCalling ?? false,
    parallelToolCalls: false,
    streaming: true,
    vision: false,
    jsonMode: false,
    maxContextTokens: 8192,
    maxOutputTokens: 4096,
    costPerInputToken: 0,
    costPerOutputToken: 0,
  }

  async function generate(
    request: GenerateRequest,
    options?: GenerateOptions,
  ): Promise<GenerateResponse> {
    const body: OllamaRequest = {
      model: config.model,
      messages: toOllamaMessages(request.messages, request.systemPrompt),
      stream: false,
      options: {
        temperature: request.temperature ?? 0.7,
        num_predict: request.maxTokens ?? 4096,
      },
    }

    if (request.stop && request.stop.length > 0) {
      body.options!.stop = request.stop
    }

    if (capabilities.toolCalling && request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable>')
      throw new Error(`Ollama HTTP ${response.status}: ${errorText}`)
    }

    const data = (await response.json()) as OllamaResponse
    const message = data.message
    const toolCalls = parseOllamaToolCalls(message.tool_calls)

    const inputTokens = data.prompt_eval_count ?? 0
    const outputTokens = data.eval_count ?? 0

    return {
      content: message.content ?? '',
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      model: data.model,
      finishReason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }
  }

  async function* stream(
    request: GenerateRequest,
    options?: GenerateOptions,
  ): AsyncGenerator<StreamChunk> {
    const body: OllamaRequest = {
      model: config.model,
      messages: toOllamaMessages(request.messages, request.systemPrompt),
      stream: true,
      options: {
        temperature: request.temperature ?? 0.7,
        num_predict: request.maxTokens ?? 4096,
      },
    }

    if (request.stop && request.stop.length > 0) {
      body.options!.stop = request.stop
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable>')
      throw new Error(`Ollama HTTP ${response.status}: ${errorText}`)
    }

    if (!response.body) {
      throw new Error('Ollama: response body is null (streaming)')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let totalInputTokens = 0
    let totalOutputTokens = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          let chunk: OllamaStreamChunk
          try {
            chunk = JSON.parse(trimmed) as OllamaStreamChunk
          } catch {
            continue
          }

          if (chunk.message?.content) {
            yield { type: 'content_delta', text: chunk.message.content }
          }

          if (chunk.done) {
            if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) {
              totalInputTokens = chunk.prompt_eval_count ?? 0
              totalOutputTokens = chunk.eval_count ?? 0
              yield {
                type: 'usage',
                usage: {
                  inputTokens: totalInputTokens,
                  outputTokens: totalOutputTokens,
                  totalTokens: totalInputTokens + totalOutputTokens,
                },
              }
            }
            yield { type: 'done' }
            return
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    yield { type: 'done' }
  }

  return {
    name: `ollama:${config.model}`,
    capabilities,
    generate,
    stream,
  }
}
