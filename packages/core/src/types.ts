/**
 * @description All TypeScript interfaces and types for the framework
 * @exports Message, AgentEvent, LLMProvider, ToolDefinition, AgentConfig, Transport, AgentHooks
 */
// ─── Messages ────────────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface MessageImage {
  /** base64-encoded image data */
  data: string
  /** MIME type: image/png, image/jpeg, etc. */
  mimeType: string
}

export interface Message {
  role: MessageRole
  content: string
  toolCallId?: string    // for role: 'tool' (observation)
  toolCalls?: ToolCall[] // for role: 'assistant' (when model calls tools)
  name?: string          // tool name for tool messages
  /** Attached images (for multimodal messages) */
  images?: MessageImage[]
}

// ─── Tool System ─────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
  source: 'builtin' | 'mcp' | 'plugin' | 'data'
  tags?: string[]
  cost: ToolCostProfile
  timeout?: number // ms, default 30000
}

export interface ToolCostProfile {
  latency: 'instant' | 'fast' | 'slow'
  tokenCost: 'none' | 'low' | 'high'
  sideEffects: boolean
  reversible: boolean
  external: boolean
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ToolResult {
  callId: string
  result: string
  error?: boolean
}

// ─── Provider ────────────────────────────────────────────────────────────────

export interface LLMProvider {
  generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResponse>
  stream?(request: GenerateRequest, options?: GenerateOptions): AsyncGenerator<StreamChunk>
  capabilities: ProviderCapabilities
  name: string
  /** Provider type identifier (e.g. 'openrouter', 'codex', 'ollama'). */
  type?: string
  /** Optional: resolve authoritative billing/cache details from a generationId.
   *  Implementations should be cheap and best-effort (network failures must not throw). */
  getGenerationDetails?(generationId: string): Promise<GenerationDetails | null>
}

export interface ProviderCapabilities {
  toolCalling: boolean
  parallelToolCalls: boolean
  streaming: boolean
  vision: boolean
  jsonMode: boolean
  maxContextTokens: number
  maxOutputTokens: number
  costPerInputToken: number
  costPerOutputToken: number
}

export interface GenerateRequest {
  messages: Message[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
  responseFormat?: 'text' | 'json'
  stop?: string[]
}

export interface GenerateOptions {
  signal?: AbortSignal
}

export interface GenerateResponse {
  content: string
  toolCalls?: ToolCall[]
  usage: TokenUsage
  model: string
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
  /** Provider-assigned generation id (e.g. OpenRouter `id`). Enables follow-up
   *  calls like provider.getGenerationDetails() for actual cost / cache stats. */
  generationId?: string
  /** Number of HTTP retries the provider performed for this call (>=0). */
  retryCount?: number
  /** Detailed transport-level metrics. Tracing splits "where time goes":
   *  network vs cognition vs first-token vs streaming. Optional — providers
   *  fill what they can measure. */
  transport?: TransportMetrics
  /** Free-form provider-specific metadata captured for tracing. */
  providerMetadata?: Record<string, unknown>
}

/** Transport-level metrics captured by the provider during a generation.
 *  Helps distinguish "the LLM is slow" from "the network is slow". */
export interface TransportMetrics {
  /** Total HTTP wall-clock latency in ms (from POST to body close). */
  httpLatencyMs?: number
  /** Time from request start to first response byte (TTFB). */
  ttfbMs?: number
  /** Time from request start to first content/tool_call delta (streaming TTFT). */
  ttftMs?: number
  /** Bytes sent on the wire (request body length). */
  requestBytes?: number
  /** Bytes received on the wire. For streaming this is the total of all chunks. */
  responseBytes?: number
  /** HTTP status code returned. */
  statusCode?: number
  /** Number of streaming chunks received (only for streamed responses). */
  streamChunks?: number
}

/** Optional follow-up details a provider may resolve from a generation id.
 *  OpenRouter exposes /api/v1/generation/{id} with the authoritative numbers. */
export interface GenerationDetails {
  generationId: string
  /** Actual cost in USD as billed by the provider — most accurate value. */
  actualCostUsd?: number
  /** Tokens served from prompt cache (subset of input tokens). */
  cachedInputTokens?: number
  /** Total provider-side latency in ms. */
  latencyMs?: number
  /** Underlying provider name (OpenRouter routes to many). */
  providerName?: string
  /** Raw payload for tracing fidelity. */
  raw?: Record<string, unknown>
}

export interface StreamChunk {
  type: 'content_delta' | 'tool_call_delta' | 'usage' | 'done'
  text?: string
  toolCall?: Partial<ToolCall>
  usage?: TokenUsage
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Tokens served from prompt cache (subset of inputTokens). Optional —
   *  set only when the provider reports it (OpenRouter, Anthropic, etc). */
  cachedInputTokens?: number
  /** Reasoning/thinking tokens billed separately from completion (o1, deepseek-r1). */
  reasoningTokens?: number
}

// ─── Agent Events ─────────────────────────────────────────────────────────────

export interface PlanStep {
  description: string
  tools?: string[]
  estimatedCost?: number
}

export type AgentEvent =
  | { type: 'thinking_start' }
  | {
      type: 'thinking_end'
      tokens: TokenUsage
      /** Model that actually served this request (post-fallback). */
      model?: string
      /** Provider that served this request ('openrouter' | 'codex' | ...). */
      provider?: string
      /** Why generation stopped — 'stop' | 'tool_calls' | 'length' | 'error'. */
      finishReason?: 'stop' | 'tool_calls' | 'length' | 'error'
      /** HTTP retries the provider performed for this generation. */
      retryCount?: number
      /** Provider-assigned id (enables follow-up cost lookup). */
      generationId?: string
      /** Wall-clock duration of the generate() call in ms. */
      latencyMs?: number
      /** Transport-level metrics (network/TTFB/TTFT/bytes). */
      transport?: TransportMetrics
    }
  /** Emitted after the request is built but before the network call.
   *  Carries the per-component token decomposition so consumers know
   *  what's actually being sent on the wire. */
  | {
      type: 'request_prepared'
      model: string
      provider: string
      systemTokens: number
      messagesTokens: number
      toolsTokens: number
      messagesCount: number
      toolsCount: number
      totalInputTokensEstimate: number
    }
  /** Emitted asynchronously after thinking_end when provider can fetch
   *  authoritative billing/cache details (OpenRouter /generation). */
  | {
      type: 'generation_details'
      generationId: string
      actualCostUsd?: number
      cachedInputTokens?: number
      latencyMs?: number
      providerName?: string
    }
  /** Emitted by the fallback provider when the primary provider failed and
   *  it switched to the next one. Critical for spotting silent quality drops. */
  | {
      type: 'provider_fallback'
      from: string
      to: string
      error: string
    }
  | { type: 'content_delta'; text: string }
  | { type: 'response'; content: string }
  | { type: 'tool_start'; tool: string; args: Record<string, unknown>; callId?: string }
  | {
      type: 'tool_result'
      tool: string
      result: string
      callId?: string
      /** Wall-clock duration of the tool execution in ms. */
      latencyMs?: number
    }
  | { type: 'tool_error'; tool: string; error: string; callId?: string; latencyMs?: number }
  | { type: 'tool_denied'; tool: string }
  | { type: 'tool_not_found'; tool: string }
  | { type: 'plan_proposed'; steps: PlanStep[] }
  | { type: 'plan_approved' }
  | { type: 'plan_rejected'; reason?: string }
  | {
      type: 'context_compacted'
      before: number
      after: number
      /** Which condenser phase actually changed the message list. */
      phase?: 'trim_tool_results' | 'drop_thinking' | 'summarize' | 'hard_truncate'
    }
  | { type: 'error'; error: string; phase: string }
  | { type: 'cancelled' }
  | { type: 'max_turns_reached'; turns: number }
  | { type: 'budget_exceeded'; cost: number }
  | { type: 'ask_user'; question: string }
  | { type: 'user_response'; response: string }
  | { type: 'intermediate_response'; content: string }
  | { type: 'messages_updated'; messages: Message[] }

// ─── Session ──────────────────────────────────────────────────────────────────

export interface SessionState {
  id: string
  agentId: string
  messages: Message[]
  summary?: string
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  totalCost: number
  totalTurns: number
  /** Task IDs created/discussed in this session */
  taskIds: string[]
  /** Tools used during the session */
  toolsUsed: string[]
  /** Sub-agents delegated to */
  agentsUsed: string[]
  /** Auto-extracted topics */
  topics: string[]
  /** First user message (for quick identification) */
  firstMessage?: string
  /** Transport: 'cli' | 'telegram' | 'api' */
  transport?: string
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface AgentConfig {
  agent: {
    id: string
    personality?: string  // path to SOUL.md or inline string
    instructions?: string // path to AGENTS.md or inline string
    skills?: string       // path to skills directory
  }
  provider: ProviderConfig
  tools?: ToolsConfig
  memory?: MemoryConfig
  limits?: LimitsConfig
  security?: SecurityConfig
  executionMode?: 'auto' | 'plan' | 'plan-always'
}

export interface ProviderConfig {
  default: { type: string; model: string; apiKey?: string; baseUrl?: string }
  planning?: { type: string; model: string; apiKey?: string; baseUrl?: string }
  condensing?: { type: string; model: string; apiKey?: string; baseUrl?: string }
}

export interface ToolsConfig {
  mcp?: Array<
    | { command: string; args?: string[]; env?: Record<string, string> }
    | { url: string }
  >
  builtin?: string[]
  budget?: 'auto' | number
}

export interface MemoryConfig {
  type?: 'sqlite' | 'postgres' | 'file'
  embeddingProvider?: 'local' | 'openai' | 'none'
  autoExtract?: boolean
}

export interface LimitsConfig {
  maxTurns?: number               // default 50
  maxCostPerSession?: number      // USD
  maxCostPerDay?: number          // USD
  maxToolCallsPerMinute?: number  // default 60
  contextBudget?: 'auto' | number
}

export interface SecurityConfig {
  permissions?: { mode: 'allow-all' | 'ask' | 'rules' | 'deny-all' }
  network?: { allowedDomains?: string[]; allowAllOutbound?: boolean }
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export interface AgentHooks {
  beforeGenerate?: (messages: Message[]) => Message[] | void | Promise<Message[] | void>
  afterGenerate?: (response: GenerateResponse) => GenerateResponse | void | Promise<GenerateResponse | void>
  beforeToolCall?: (call: ToolCall) => ToolCall | null | Promise<ToolCall | null>
  afterToolCall?: (call: ToolCall, result: string) => string | void | Promise<string | void>
  onError?: (error: Error, phase: string) => 'retry' | 'skip' | 'abort' | Promise<'retry' | 'skip' | 'abort'>
  onSessionStart?: (sessionId: string) => void | Promise<void>
  onSessionEnd?: (sessionId: string) => void | Promise<void>
}

// ─── Transport ────────────────────────────────────────────────────────────────

/**
 * Per-message context provided by the transport. Lets the agent layer route
 * to the right session, attribute author identity in groups, and pass
 * user/chat metadata into tracing without coupling to any specific transport.
 */
export interface MessageContext {
  /**
   * Stable identifier for the conversation thread this message belongs to.
   * Different transports compose this differently:
   *   - cli                : a single id per process
   *   - telegram private   : "tg:<chatId>"
   *   - telegram group     : "tg:<chatId>:u<userId>"        (per-author)
   *   - telegram forum     : "tg:<chatId>:t<threadId>"      (per-topic)
   *
   * The agent layer treats it as opaque — it just resumes/persists per id.
   */
  sessionId: string
  /** Author of the message. Absent for transports without identity (CLI). */
  sender?: MessageSender
  /** Chat metadata for groups/channels. Absent for 1:1. */
  chat?: MessageChat
  /** Optional images attached to the message. */
  images?: MessageImage[]
}

export interface MessageSender {
  /** Stable per-transport user id (Telegram numeric id, etc). */
  id: string
  /** Display name as shown in the transport (Telegram first/last). */
  displayName?: string
  /** Handle / @username if the transport supports it. */
  username?: string
  /** True if this user has admin rights in the current chat. */
  isAdmin?: boolean
}

export interface MessageChat {
  /** Stable transport chat id. */
  id: string
  /** "private" | "group" | "supergroup" | "channel" | "cli". */
  kind: 'private' | 'group' | 'supergroup' | 'channel' | 'cli'
  /** Human-readable title (group name, channel name). */
  title?: string
  /** Telegram message_thread_id for forum supergroups. */
  threadId?: number
  /** Optional human label of the topic (forum topic name). */
  threadTitle?: string
}

export interface Transport {
  onMessage(handler: (message: string, ctx: MessageContext) => void): void
  send(event: AgentEvent, sessionId: string): void | Promise<void>
  onCancel?(handler: (sessionId: string) => void): void
  start(): Promise<void>
  stop(): Promise<void>
  readonly ready: boolean
}

// ─── Helper ───────────────────────────────────────────────────────────────────

export function defineConfig(config: AgentConfig): AgentConfig {
  return config
}
