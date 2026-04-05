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
}

// ─── Agent Events ─────────────────────────────────────────────────────────────

export interface PlanStep {
  description: string
  tools?: string[]
  estimatedCost?: number
}

export type AgentEvent =
  | { type: 'thinking_start' }
  | { type: 'thinking_end'; tokens: TokenUsage }
  | { type: 'content_delta'; text: string }
  | { type: 'response'; content: string }
  | { type: 'tool_start'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: string }
  | { type: 'tool_error'; tool: string; error: string }
  | { type: 'tool_denied'; tool: string }
  | { type: 'tool_not_found'; tool: string }
  | { type: 'plan_proposed'; steps: PlanStep[] }
  | { type: 'plan_approved' }
  | { type: 'plan_rejected'; reason?: string }
  | { type: 'context_compacted'; before: number; after: number }
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

export interface Transport {
  onMessage(handler: (message: string, sessionId: string, images?: MessageImage[]) => void): void
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
