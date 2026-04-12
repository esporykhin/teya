/**
 * @description Main agent loop — think, act, observe cycle with error recovery, tool execution, and context management
 * @exports agentLoop
 */
import type { Message, AgentEvent, LLMProvider, ToolCall, ToolDefinition, ToolResult, AgentHooks, ProviderCapabilities } from './types.js'
import { PermissionEngine, sanitizeExternalResult, checkDLP, type PermissionConfig } from './security.js'
import { getCurrentSession } from './session-context.js'

// ─── Context utilities (inlined to avoid circular dep: @teya/context imports @teya/core) ──

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 10, 0)
}

function calculateBudget(capabilities: Pick<ProviderCapabilities, 'maxContextTokens' | 'maxOutputTokens'>): {
  effectiveBudget: number
  condenserThreshold: number
} {
  const outputReserve = capabilities.maxOutputTokens + 500
  const effectiveBudget = capabilities.maxContextTokens - outputReserve
  const condenserThreshold = Math.floor(effectiveBudget * 0.75)
  return { effectiveBudget, condenserThreshold }
}

// Summarizer: takes a slice of messages and returns a summary string
type Summarizer = (messages: Message[]) => Promise<string>

type CondensePhase = 'trim_tool_results' | 'drop_thinking' | 'summarize' | 'hard_truncate'

interface CondenseResult {
  messages: Message[]
  /** Last phase that actually mutated the message list. Used by tracing. */
  phase: CondensePhase
}

async function condenseMessagesAsync(messages: Message[], budget: number, summarizer?: Summarizer): Promise<CondenseResult> {
  let current = [...messages]
  let phase: CondensePhase = 'trim_tool_results'

  // Phase 1: Trim old tool results (keep last 10 messages untouched)
  const toolResultCutoff = Math.max(0, current.length - 10)
  for (let i = 0; i < toolResultCutoff; i++) {
    if (current[i].role === 'tool' && current[i].content.length > 200) {
      current[i] = { ...current[i], content: current[i].content.slice(0, 200) + '\n[...truncated]' }
    }
  }
  if (estimateMessagesTokens(current) <= budget) return { messages: current, phase }

  // Phase 2: Remove thinking tool results
  phase = 'drop_thinking'
  current = current.filter((m, i) => {
    if (m.role === 'tool' && m.name === 'core:think' && i < toolResultCutoff) return false
    return true
  })
  if (estimateMessagesTokens(current) <= budget) return { messages: current, phase }

  // Phase 3: LLM Summarization
  if (summarizer && estimateMessagesTokens(current) > budget) {
    phase = 'summarize'
    const systemMessages = current.filter(m => m.role === 'system')
    const nonSystemMessages = current.filter(m => m.role !== 'system')
    const splitPoint = Math.floor(nonSystemMessages.length * 0.6)
    const toSummarize = nonSystemMessages.slice(0, splitPoint)
    const toKeep = nonSystemMessages.slice(splitPoint)

    if (toSummarize.length > 2) {
      try {
        const summary = await summarizer(toSummarize)
        current = [
          ...systemMessages,
          { role: 'system' as const, content: `[Conversation summary]\n${summary}` },
          ...toKeep,
        ]
      } catch {
        // Summarization failed — fall through to hard truncation
      }
    }
  }
  if (estimateMessagesTokens(current) <= budget) return { messages: current, phase }

  // Phase 4: Hard truncation — keep system messages + last N messages
  phase = 'hard_truncate'
  const systemMessages = current.filter(m => m.role === 'system')
  const nonSystemMessages = current.filter(m => m.role !== 'system')

  let keepCount = nonSystemMessages.length
  while (keepCount > 5 && estimateMessagesTokens([...systemMessages, ...nonSystemMessages.slice(-keepCount)]) > budget) {
    keepCount = Math.floor(keepCount * 0.7)
  }

  const keptMessages = nonSystemMessages.slice(-keepCount)
  const truncatedSummary: Message = {
    role: 'system',
    content: `[Earlier messages truncated. ${nonSystemMessages.length - keepCount} messages removed to fit context window.]`,
  }

  return { messages: [...systemMessages, truncatedSummary, ...keptMessages], phase }
}

/**
 * Generate a compact summary of a tool result for sliding-window
 * compaction. Tool-specific where useful (extracts exit codes, status
 * codes, file ops); generic fallback otherwise.
 *
 * Output stays under ~150 chars so the in-history footprint drops from
 * full result (often 1000-5000 chars) to a tiny pointer + retrieval id.
 */
function summarizeToolResult(toolName: string, content: string, callId: string): string {
  const orig = content.length
  const firstLine = content.split('\n')[0]?.trim() || ''
  const preview = content.slice(0, 200).replace(/\s+/g, ' ').trim()

  // Tool-specific extractors — pull the most informative bit.
  let detail = ''
  if (toolName === 'core:exec') {
    const exitMatch = content.match(/Exit code (\d+)/i) || content.match(/exit:?\s*(\d+)/i)
    if (exitMatch) detail = `exit=${exitMatch[1]}, `
    const lines = content.split('\n').length
    detail += `${lines} lines`
  } else if (toolName === 'core:web' || toolName === 'core:web_fetch' || toolName === 'core:http_request') {
    const statusMatch = content.match(/HTTP\s+(\d{3})/i) || content.match(/"status":\s*(\d{3})/)
    if (statusMatch) detail = `HTTP ${statusMatch[1]}, `
    detail += `${orig} chars`
  } else if (toolName === 'core:files') {
    detail = `${firstLine.slice(0, 80)}`
  } else if (toolName === 'core:memory') {
    const lines = content.split('\n').length
    detail = `${lines} entries`
  } else if (toolName === 'core:tasks') {
    detail = `${firstLine.slice(0, 80)}`
  } else {
    detail = `${orig} chars`
  }

  return [
    `[#${callId} ${toolName} truncated — ${detail}]`,
    `First 200: ${preview}`,
    `[Use core:tool_result_get(id="${callId}") to retrieve full content]`,
  ].join('\n')
}

/**
 * Sliding window compaction over the message list. For every tool result
 * that's older than `windowSize` LLM steps AND larger than `minChars`,
 * stash the full content into the session's tool result store and replace
 * the in-history copy with a compact summary.
 *
 * Pure mutation of the messages array (returns it unchanged in identity,
 * mutates entries in place — caller is responsible for passing a copy).
 *
 * Returns metadata about what was compacted so the agent loop can emit
 * tool_result_truncated events for tracing.
 */
export interface SlidingCompactionResult {
  truncations: Array<{ callId: string; tool: string; originalChars: number; newChars: number; ageInLLMSteps: number }>
}

export function applySlidingWindow(
  messages: Message[],
  opts: { windowSize?: number; minChars?: number } = {},
): SlidingCompactionResult {
  const windowSize = opts.windowSize ?? 3
  const minChars = opts.minChars ?? 500

  // Walk from the end backwards, counting LLM steps as we go.
  // An "LLM step" is one assistant message (each assistant reply marks
  // the boundary between calls). Tool messages don't count as steps —
  // they're the result of the previous assistant call.
  let llmStepCount = 0
  const truncations: SlidingCompactionResult['truncations'] = []
  const session = getCurrentSession()

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'assistant') {
      llmStepCount++
      continue
    }
    if (msg.role !== 'tool') continue

    // Tool message — check age and size
    if (llmStepCount <= windowSize) continue // still within recent window
    if (!msg.content || msg.content.length <= minChars) continue
    // Already compacted? Detect by our marker prefix.
    if (msg.content.startsWith('[#')) continue

    const callId = msg.toolCallId || `unknown-${i}`
    const toolName = msg.name || 'unknown'
    const originalChars = msg.content.length

    // Stash full content in session store BEFORE rewriting the message.
    if (session) {
      session.toolResults.set(callId, {
        id: callId,
        toolName,
        argsSummary: '',
        fullContent: msg.content,
        createdAt: Date.now() - llmStepCount * 1000, // approximate
        retrievedCount: 0,
      })
    }

    const summary = summarizeToolResult(toolName, msg.content, callId)
    msg.content = summary
    truncations.push({
      callId,
      tool: toolName,
      originalChars,
      newChars: summary.length,
      ageInLLMSteps: llmStepCount,
    })
  }

  return { truncations }
}

/** Estimate tokens spent on tool definitions (name, description, JSON schema). */
function estimateToolsTokens(tools: ToolDefinition[]): number {
  let chars = 0
  for (const t of tools) {
    chars += (t.name?.length || 0) + (t.description?.length || 0)
    try { chars += JSON.stringify(t.parameters).length } catch {}
    chars += 20 // structural overhead per tool
  }
  return Math.ceil(chars / 3.5)
}

function truncateToolResult(result: string, maxChars: number = 5000): string {
  if (result.length <= maxChars) return result
  if (result.startsWith('Error:') || result.startsWith('error:')) return result.slice(0, maxChars * 2)
  const headBudget = Math.floor(maxChars * 0.6)
  const tailBudget = Math.floor(maxChars * 0.3)
  const head = result.slice(0, headBudget)
  const tail = result.slice(-tailBudget)
  return `${head}\n\n[...truncated, ${result.length} chars total...]\n\n${tail}`
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToolRegistry {
  get(name: string): (ToolDefinition & { execute: (args: Record<string, unknown>) => Promise<string> }) | undefined
  list(): ToolDefinition[]
  listNames(): string[]
  execute(call: ToolCall): Promise<ToolResult>
}

export interface ToolLoader {
  selectTools(message: string, capabilities: ProviderCapabilities): ToolDefinition[]
  markUsed(toolName: string): void
}

export interface AgentLoopDeps {
  provider: LLMProvider
  toolRegistry: ToolRegistry
  toolLoader?: ToolLoader
  systemPrompt: string
  config: {
    maxTurns?: number
    maxCostPerSession?: number
    executionMode?: 'auto' | 'plan' | 'plan-always'
  }
  hooks?: AgentHooks
  permissions?: PermissionConfig
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool timed out after ${ms}ms`)), ms)
    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })
}

// ─── Tool execution result ────────────────────────────────────────────────────

interface ToolExecResult {
  events: AgentEvent[]
  message: Message
}

// ─── executeToolCall ──────────────────────────────────────────────────────────
// Shared helper used by both parallel (read) and sequential (write) paths.
// Does NOT yield — collects events into an array so the caller can yield them.

async function executeToolCall(
  call: ToolCall,
  deps: AgentLoopDeps,
  permissionEngine: PermissionEngine,
  recentUserMessages: string[],
): Promise<ToolExecResult> {
  const events: AgentEvent[] = []

  // Normalize args — handle _raw fallback from provider parsing failures
  if (call.args._raw && typeof call.args._raw === 'string' && Object.keys(call.args).length === 1) {
    try {
      const reparsed = JSON.parse(call.args._raw as string)
      if (typeof reparsed === 'object' && reparsed !== null) {
        call = { ...call, args: reparsed }
      }
    } catch {
      // _raw is not parseable — leave args as-is, tool will get _raw field
    }
  }

  const tool = deps.toolRegistry.get(call.name)
  if (!tool) {
    events.push({ type: 'tool_not_found', tool: call.name })
    return {
      events,
      message: {
        role: 'tool',
        content: `Error: Tool "${call.name}" not found. Available tools: ${deps.toolRegistry.listNames().join(', ')}`,
        toolCallId: call.id,
        name: call.name,
      },
    }
  }

  // Permission check
  const permResult = permissionEngine.check(call, tool.cost)
  if (permResult === 'deny') {
    events.push({ type: 'tool_denied', tool: call.name })
    return {
      events,
      message: {
        role: 'tool',
        content: 'Tool call denied by permission policy.',
        toolCallId: call.id,
        name: call.name,
      },
    }
  }
  if (permResult === 'ask') {
    // For v1: yield ask event and auto-allow (proper ask flow needs transport interaction)
    events.push({ type: 'tool_denied', tool: call.name })
    return {
      events,
      message: {
        role: 'tool',
        content: 'Tool call requires user approval (auto-allowed in v1).',
        toolCallId: call.id,
        name: call.name,
      },
    }
  }

  // DLP check
  const dlpResult = checkDLP(call, tool.cost, recentUserMessages)
  if (!dlpResult.allowed) {
    events.push({ type: 'tool_denied', tool: call.name })
    return {
      events,
      message: {
        role: 'tool',
        content: `Blocked: ${dlpResult.reason}`,
        toolCallId: call.id,
        name: call.name,
      },
    }
  }

  let toolCall = call
  if (deps.hooks?.beforeToolCall) {
    const modified = await deps.hooks.beforeToolCall(toolCall)
    if (modified === null) {
      events.push({ type: 'tool_denied', tool: call.name })
      return {
        events,
        message: {
          role: 'tool',
          content: 'Tool call cancelled by hook.',
          toolCallId: call.id,
          name: call.name,
        },
      }
    }
    toolCall = modified
  }

  events.push({ type: 'tool_start', tool: toolCall.name, args: toolCall.args, callId: toolCall.id })

  let result: ToolResult
  const toolStartedAt = Date.now()
  try {
    result = await withTimeout(deps.toolRegistry.execute(toolCall), tool.timeout ?? 30000)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    events.push({
      type: 'tool_error',
      tool: toolCall.name,
      error: errMsg,
      callId: toolCall.id,
      latencyMs: Date.now() - toolStartedAt,
    })
    return {
      events,
      message: {
        role: 'tool',
        content: `Error: ${errMsg}`,
        toolCallId: toolCall.id,
        name: toolCall.name,
      },
    }
  }
  const toolLatencyMs = Date.now() - toolStartedAt

  // ask_user is a special sentinel — yield and let caller inject the answer
  if (result.result.startsWith('__ASK_USER__:')) {
    const question = result.result.slice('__ASK_USER__:'.length)
    events.push({ type: 'ask_user', question })
    return {
      events,
      message: {
        role: 'tool',
        content: 'Waiting for user response...',
        toolCallId: call.id,
        name: call.name,
      },
    }
  }

  // plan is a special sentinel — show plan to user, then auto-approve (v1)
  if (result.result.startsWith('__PLAN__:')) {
    const planData = JSON.parse(result.result.slice('__PLAN__:'.length))
    events.push({ type: 'plan_proposed', steps: planData.steps })
    // v1: auto-approve — plan is informational, not blocking
    // TODO: implement interactive plan approval flow with transport interaction
    events.push({ type: 'plan_approved' })
    return {
      events,
      message: {
        role: 'tool',
        content: `Plan created with ${planData.steps.length} steps. Proceeding with execution.`,
        toolCallId: call.id,
        name: call.name,
      },
    }
  }

  // respond is a special sentinel — send intermediate message to user, continue loop
  if (result.result.startsWith('__RESPOND__:')) {
    const message = result.result.slice('__RESPOND__:'.length)
    events.push({ type: 'intermediate_response', content: message })
    return {
      events,
      message: {
        role: 'tool',
        content: `Sent to user: ${message}`,
        toolCallId: call.id,
        name: call.name,
      },
    }
  }

  let resultContent = truncateToolResult(result.result, 5000)
  if (deps.hooks?.afterToolCall) {
    const modified = await deps.hooks.afterToolCall(toolCall, resultContent)
    if (modified) resultContent = modified
  }

  // Sanitize external results (but NOT errors — keep errors clean)
  if (tool.cost?.external && !result.error) {
    resultContent = sanitizeExternalResult(resultContent, call.name)
  }

  if (result.error) {
    events.push({
      type: 'tool_error',
      tool: toolCall.name,
      error: resultContent,
      callId: toolCall.id,
      latencyMs: toolLatencyMs,
    })
  } else {
    events.push({
      type: 'tool_result',
      tool: toolCall.name,
      result: resultContent,
      callId: toolCall.id,
      latencyMs: toolLatencyMs,
    })
  }

  return {
    events,
    message: {
      role: 'tool',
      content: resultContent,
      toolCallId: toolCall.id,
      name: toolCall.name,
    },
  }
}

// ─── agentLoop ────────────────────────────────────────────────────────────────

export async function* agentLoop(
  deps: AgentLoopDeps,
  userMessage: string,
  conversationHistory: Message[],
  signal?: AbortSignal,
  /** Optional images attached to the user message */
  images?: import('./types.js').MessageImage[],
): AsyncGenerator<AgentEvent> {
  let messages: Message[] = [...conversationHistory]
  messages.push({ role: 'user', content: userMessage, images })

  const budget = calculateBudget(deps.provider.capabilities)
  const permissionEngine = new PermissionEngine(deps.permissions)

  // Build summarizer using provider (used in Phase 3 of condenser)
  const summarizer: Summarizer = async (msgs: Message[]) => {
    const text = msgs.map(m => `${m.role}: ${m.content.slice(0, 500)}`).join('\n')
    const response = await deps.provider.generate({
      messages: [{
        role: 'user',
        content: `Summarize this conversation concisely. Preserve key facts, decisions, and context needed to continue the conversation. Be brief.\n\n${text}`,
      }],
      maxTokens: 500,
    })
    return response.content
  }

  let turnCount = 0
  let totalCost = 0
  const maxTurns = deps.config.maxTurns ?? 50
  const maxCost = deps.config.maxCostPerSession ?? 10

  // Execution mode: 'auto' skips plan requirement, 'plan'/'plan-always' require core:plan before action tools
  let planApproved = (deps.config.executionMode ?? 'auto') === 'auto'

  // Session hooks
  if (deps.hooks?.onSessionStart) {
    await deps.hooks.onSessionStart('session')
  }

  // Loop detection: track signatures of recent tool calls
  const recentToolCalls: string[] = []

  while (true) {
    // Check cancellation
    if (signal?.aborted) {
      yield { type: 'cancelled' }
      break
    }

    // Check turn limit
    if (++turnCount > maxTurns) {
      yield { type: 'max_turns_reached', turns: turnCount }
      break
    }

    // Check cost limit
    if (totalCost > maxCost) {
      yield { type: 'budget_exceeded', cost: totalCost }
      break
    }

    // ── 1. THINKING — call LLM ───────────────────────────────────────────────

    yield { type: 'thinking_start' }

    let response
    const generateStartedAt = Date.now()
    try {
      let contextMessages: Message[] = [
        { role: 'system', content: deps.systemPrompt },
        ...messages,
      ]

      if (deps.hooks?.beforeGenerate) {
        const modified = await deps.hooks.beforeGenerate(contextMessages)
        if (modified) contextMessages = modified
      }

      const toolsForRequest = deps.toolLoader
        ? deps.toolLoader.selectTools(userMessage, deps.provider.capabilities)
        : deps.toolRegistry.list()

      // Count how many tools are sent with full schema vs as stubs.
      // Stub-mode tools have a placeholder description ending with "[STUB —"
      // — that's the only signal we have without changing the type.
      let toolsFullCount = 0
      let toolsStubCount = 0
      for (const t of toolsForRequest) {
        if ((t.description || '').includes('[STUB —')) toolsStubCount++
        else toolsFullCount++
      }

      // Token decomposition — emitted BEFORE the network call so tracing can
      // see exactly how the input budget is split. This is the answer to
      // "where are my tokens going" questions.
      const systemTokens = estimateTokens(deps.systemPrompt)
      const messagesTokens = estimateMessagesTokens(messages)
      const toolsTokens = estimateToolsTokens(toolsForRequest)
      yield {
        type: 'request_prepared',
        model: (deps.provider as { name?: string }).name || 'unknown',
        provider: (deps.provider as { type?: string }).type || 'unknown',
        systemTokens,
        messagesTokens,
        toolsTokens,
        messagesCount: messages.length,
        toolsCount: toolsForRequest.length,
        toolsFullCount,
        toolsStubCount,
        totalInputTokensEstimate: systemTokens + messagesTokens + toolsTokens,
      }

      response = await deps.provider.generate(
        { messages: contextMessages, tools: toolsForRequest },
        { signal }
      )

      if (deps.hooks?.afterGenerate) {
        const modified = await deps.hooks.afterGenerate(response)
        if (modified) response = modified
      }

      const inputCost =
        response.usage.inputTokens * (deps.provider.capabilities.costPerInputToken || 0)
      const outputCost =
        response.usage.outputTokens * (deps.provider.capabilities.costPerOutputToken || 0)
      totalCost += inputCost + outputCost
    } catch (error: unknown) {
      if (signal?.aborted) {
        yield { type: 'cancelled' }
        break
      }

      const errMsg = error instanceof Error ? error.message : String(error)

      // Let hook decide
      if (deps.hooks?.onError) {
        const action = await deps.hooks.onError(error as Error, 'thinking')
        if (action === 'retry') continue
        if (action === 'skip') break
      }

      // Inject error as a system message so the agent can explain it to the user
      messages.push({ role: 'system', content: `[SYSTEM ERROR] The following error occurred while processing. Explain this to the user in their language, suggest what they can do (retry, switch model, etc). Error: ${errMsg}` })

      // Try one more generate call so the agent can respond about the error
      try {
        const errorResponse = await deps.provider.generate({
          messages,
          systemPrompt: deps.systemPrompt,
          temperature: 0.3,
          maxTokens: 500,
        })
        const explanation = errorResponse.content || errMsg
        messages.push({ role: 'assistant', content: explanation })
        yield { type: 'response', content: explanation }
        yield { type: 'messages_updated', messages: [...messages] }
      } catch {
        // Even the error explanation failed — fall back to raw error
        const fallback = `Error: ${errMsg}`
        messages.push({ role: 'assistant', content: fallback })
        yield { type: 'response', content: fallback }
        yield { type: 'messages_updated', messages: [...messages] }
      }
      break
    }

    const generateLatencyMs = Date.now() - generateStartedAt
    yield {
      type: 'thinking_end',
      tokens: response.usage,
      model: response.model,
      provider: (deps.provider as { type?: string }).type,
      finishReason: response.finishReason,
      retryCount: response.retryCount,
      generationId: response.generationId,
      latencyMs: generateLatencyMs,
      transport: response.transport,
    }

    // The generationId is included in `thinking_end` above. Authoritative
    // billing details (cost, cached tokens, provider) are looked up
    // asynchronously by a higher-level enricher (see GenerationEnricher in
    // @teya/tracing) — we don't block the agent loop on a follow-up HTTP call,
    // because OpenRouter's /generation endpoint takes 2-5s to surface fresh
    // ids. The enricher emits a synthetic `generation_details` event into
    // the tracer when it resolves.

    // ── 2. No tool calls — emit response and stop ────────────────────────────

    if (!response.toolCalls?.length) {
      messages.push({ role: 'assistant', content: response.content })
      yield { type: 'response', content: response.content }
      break
    }

    // ── 3. Add assistant message with tool calls to history ──────────────────

    messages.push({
      role: 'assistant',
      content: response.content || '',
      toolCalls: response.toolCalls,
    })

    // ── 4. Loop detection ────────────────────────────────────────────────────

    for (const call of response.toolCalls) {
      const sig = `${call.name}:${JSON.stringify(call.args)}`
      recentToolCalls.push(sig)
      if (recentToolCalls.length > 5) recentToolCalls.shift()
    }

    if (recentToolCalls.length >= 3) {
      const last3 = recentToolCalls.slice(-3)
      if (last3[0] === last3[1] && last3[1] === last3[2]) {
        messages.push({
          role: 'system',
          content:
            'You are repeating the same tool call. Try a different approach or ask the user for help.',
        })
      }
    }

    // ── 5. ACTING — classify and execute tool calls ──────────────────────────

    const recentUserMessages = messages.filter(m => m.role === 'user').map(m => m.content).slice(-5)

    // Plan mode enforcement: block action tools until core:plan has been called
    let effectiveToolCalls = response.toolCalls
    if (!planApproved) {
      const hasActionTools = effectiveToolCalls.some(c => {
        const t = deps.toolRegistry.get(c.name)
        return t?.cost?.sideEffects && c.name !== 'core:plan'
      })
      if (hasActionTools) {
        messages.push({
          role: 'system',
          content: 'You are in plan mode. Create a plan using core:plan before executing action tools.',
        })
        // Retain only non-action tools and core:plan for this round
        effectiveToolCalls = effectiveToolCalls.filter(c => {
          const t = deps.toolRegistry.get(c.name)
          return !t?.cost?.sideEffects || c.name === 'core:plan'
        })
      }
    }

    const readCalls: ToolCall[] = []
    const writeCalls: ToolCall[] = []

    for (const call of effectiveToolCalls) {
      const tool = deps.toolRegistry.get(call.name)
      if (tool?.cost?.sideEffects === false) {
        readCalls.push(call)
      } else {
        // Conservative: unknown cost profile → sequential
        writeCalls.push(call)
      }
    }

    // Check cancellation before acting
    if (signal?.aborted) {
      yield { type: 'cancelled' }
      return
    }

    // Execute read-only calls in parallel
    if (readCalls.length > 0) {
      const readResults = await Promise.all(
        readCalls.map((call) => executeToolCall(call, deps, permissionEngine, recentUserMessages))
      )
      for (let i = 0; i < readResults.length; i++) {
        const r = readResults[i]
        for (const e of r.events) yield e
        messages.push(r.message)
        deps.toolLoader?.markUsed(readCalls[i].name)
      }
    }

    // Execute write/unknown calls sequentially; detect plan_approved to unlock action tools
    for (const call of writeCalls) {
      if (signal?.aborted) {
        yield { type: 'cancelled' }
        return
      }

      const r = await executeToolCall(call, deps, permissionEngine, recentUserMessages)
      for (const e of r.events) {
        if (e.type === 'plan_approved') planApproved = true
        yield e
      }
      messages.push(r.message)
      deps.toolLoader?.markUsed(call.name)
    }

    // ── 6a. Sliding window compaction (per-turn, not budget-driven) ──────────
    // Always run on every loop iteration. Compacts tool results older than
    // 3 LLM steps and larger than 500 chars into compact summary + retrieval
    // marker. Full content is stashed in the session's tool result store
    // (via getCurrentSession()), retrievable through core:tool_result_get.
    // This is the cheap, always-on optimization that prevents the "20-call
    // turn re-pays for old web fetch results" problem.
    const slidingResult = applySlidingWindow(messages, { windowSize: 3, minChars: 500 })
    for (const t of slidingResult.truncations) {
      yield {
        type: 'tool_result_truncated',
        callId: t.callId,
        tool: t.tool,
        originalChars: t.originalChars,
        newChars: t.newChars,
        ageInLLMSteps: t.ageInLLMSteps,
      }
    }

    // ── 6b. Condense context if budget-pressured ─────────────────────────────
    const currentTokens = estimateMessagesTokens(messages)
    if (currentTokens > budget.condenserThreshold) {
      const condensed = await condenseMessagesAsync(messages, budget.effectiveBudget, summarizer)
      const afterTokens = estimateMessagesTokens(condensed.messages)
      yield {
        type: 'context_compacted',
        before: currentTokens,
        after: afterTokens,
        phase: condensed.phase,
      }
      messages = condensed.messages
    }

    // Continue loop — LLM will see tool results and decide the next step
  }

  if (deps.hooks?.onSessionEnd) {
    await deps.hooks.onSessionEnd('session')
  }

  yield { type: 'messages_updated', messages: [...messages] }
}
