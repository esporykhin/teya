/**
 * @description Converts AgentEvent stream into rich OTEL-compatible spans.
 *
 * Architecture: this module is a pure consumer of AgentEvent. It does not
 * touch the network, filesystem or providers. All enrichment data
 * (model, retries, cached tokens, generation cost) is delivered to the
 * tracer via richer AgentEvent variants emitted by core/agent-loop and
 * the providers themselves. Keep this contract — it lets us evolve
 * tracing without coupling.
 */
import type { AgentEvent, ProviderCapabilities } from '@teya/core'
import { createSpan, endSpan, type Span } from './span.js'

export type TracingExporter = (span: Span) => void

export interface TracerConfig {
  /** Provider capabilities for fallback cost calculation when generation
   *  details are unavailable. */
  capabilities?: ProviderCapabilities
  /** Truncation budget for tool args/results captured in spans. Default 5000.
   *  Big enough for code edits and shell commands; trimmed to keep traces small. */
  toolPayloadLimit?: number
  /** Default parent span id for new agent.turn spans. Used by sub-agent
   *  tracers spawned via spawnChild() — they nest under a delegate.X span. */
  defaultRootParent?: string
  /** Reuse a specific traceId instead of generating one. Used by spawnChild. */
  inheritTraceId?: string
}

/**
 * Per-session context the tracer attaches to every span as attributes.
 * Set via setContext() before processing events for a given turn so that
 * spans can be filtered by session/agent/transport in any downstream tool.
 */
export interface TraceContext {
  sessionId?: string
  agentId?: string
  transport?: string
  /** Latest user message that drove the current turn — first 500 chars. */
  userMessage?: string
}

const DEFAULT_PAYLOAD_LIMIT = 5000

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s
  return s.slice(0, limit) + `\n[...truncated, ${s.length} chars total]`
}

function estimateTokens(text: string): number {
  return Math.ceil((text?.length || 0) / 3.5)
}

export class AgentTracer {
  private exporter: TracingExporter
  private traceId: string
  private currentLLMSpan: Span | null = null
  private currentToolSpans = new Map<string, Span>() // keyed by callId for parallel tools
  private turnSpan: Span | null = null
  private turnCount = 0
  private capabilities?: ProviderCapabilities
  private payloadLimit: number
  private sessionCost = 0
  private actualCostFromProvider = 0 // sum of authoritative billing
  private context: TraceContext = {}
  private defaultRootParent?: string
  /** Span id of the most recently CLOSED context.compact span. The next
   *  llm.generate uses this to attribute its input savings to that compaction. */
  private lastCompactSpanId: string | null = null
  private lastCompactBeforeTokens = 0
  private lastCompactAfterTokens = 0
  /** Long-lived span representing the entire CLI session. Lazy-opened on the
   *  first thinking_start, closed via finishSession() at /clear or /exit. */
  private sessionSpan: Span | null = null
  // Session-wide aggregates updated as turns close.
  private sessionTotalInputTokens = 0
  private sessionTotalOutputTokens = 0
  private sessionTotalCachedTokens = 0
  private sessionTotalToolCalls = 0
  private sessionTotalLLMCalls = 0
  private sessionTotalTurns = 0
  private sessionFallbackCount = 0
  private sessionErrorCount = 0

  // Per-turn aggregates — exposed via the agent.turn span at end-of-turn.
  // A "turn" = one user message → final response. It may include MANY
  // llm.generate calls (think → tool → think → response).
  private turnInputTokens = 0
  private turnOutputTokens = 0
  private turnCachedTokens = 0
  private turnCost = 0
  private turnToolsInvoked = 0
  private turnLLMCalls = 0

  constructor(exporter: TracingExporter, config?: TracerConfig) {
    this.exporter = exporter
    this.traceId = config?.inheritTraceId
      || Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    this.capabilities = config?.capabilities
    this.payloadLimit = config?.toolPayloadLimit ?? DEFAULT_PAYLOAD_LIMIT
    this.defaultRootParent = config?.defaultRootParent
  }

  /**
   * Spawn a child tracer for sub-agent execution. The child:
   *  - shares the parent's exporter and traceId (so spans link in any viewer)
   *  - has its own turn/llm/tool span state (independent timing)
   *  - nests every new agent.turn span under `parentSpanId`
   *  - inherits parent context but lets caller override agentId
   *
   * The parent tracer is responsible for opening/closing the wrapping span
   * (typically `delegate.<sub-agent>`) and passing its spanId here.
   */
  spawnChild(parentSpanId: string, contextOverride?: Partial<TraceContext>): AgentTracer {
    const child = new AgentTracer(this.exporter, {
      capabilities: this.capabilities,
      toolPayloadLimit: this.payloadLimit,
      defaultRootParent: parentSpanId,
      inheritTraceId: this.traceId,
    })
    child.setContext({ ...this.context, ...contextOverride })
    return child
  }

  /**
   * Open a synthetic delegate.<id> span that becomes the parent for sub-agent
   * spans. Returns the spanId so callers can spawnChild() and later close it
   * via finishDelegateSpan().
   */
  beginDelegateSpan(agentId: string, task: string): Span {
    const span = this.withContext(
      createSpan(`delegate.${agentId}`, this.turnSpan?.spanId || this.defaultRootParent, this.traceId),
    )
    span.attributes['delegate.agent_id'] = agentId
    span.attributes['delegate.task'] = truncate(task, this.payloadLimit)
    return span
  }

  finishDelegateSpan(span: Span, status: 'completed' | 'failed' | 'timeout', summary?: { turns?: number; cost?: number }): void {
    span.attributes['delegate.status'] = status
    if (summary?.turns !== undefined) span.attributes['delegate.turns'] = summary.turns
    if (summary?.cost !== undefined && summary.cost > 0) {
      span.attributes['delegate.cost.usd'] = Math.round(summary.cost * 1_000_000) / 1_000_000
    }
    endSpan(span, status === 'completed' ? 'ok' : 'error')
    this.exporter(span)
  }

  /** Update the trace-level context. Subsequent spans will inherit it. */
  setContext(ctx: Partial<TraceContext>): void {
    this.context = { ...this.context, ...ctx }
  }

  /** Snapshot of the current trace context — used by the enricher to
   *  restore the right session.id when emitting late spans. */
  getContext(): TraceContext {
    return { ...this.context }
  }

  /** Reset trace id and per-session counters. Use when starting a fresh session. */
  resetForNewSession(sessionId?: string): void {
    // Close any in-progress session rollup before wiping state.
    this.finishSession('reset')
    this.traceId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    this.sessionCost = 0
    this.actualCostFromProvider = 0
    this.turnCount = 0
    this.turnSpan = null
    this.currentLLMSpan = null
    this.currentToolSpans.clear()
    this.sessionSpan = null
    this.sessionTotalInputTokens = 0
    this.sessionTotalOutputTokens = 0
    this.sessionTotalCachedTokens = 0
    this.sessionTotalToolCalls = 0
    this.sessionTotalLLMCalls = 0
    this.sessionTotalTurns = 0
    this.sessionFallbackCount = 0
    this.sessionErrorCount = 0
    if (sessionId !== undefined) this.context.sessionId = sessionId
  }

  /** Lazily open the session-rollup span on first activity. Top-level only —
   *  sub-agent tracers (which have defaultRootParent set) skip this. */
  private ensureSessionSpan(): void {
    if (this.sessionSpan || this.defaultRootParent) return
    this.sessionSpan = this.withContext(createSpan('agent.session', undefined, this.traceId))
    if (this.context.sessionId) this.sessionSpan.attributes['session.id'] = this.context.sessionId
  }

  /** Close the session rollup span and emit final aggregates. Idempotent.
   *  Reason is recorded so post-mortem can distinguish /exit from /clear. */
  finishSession(reason: 'exit' | 'reset' | 'crash' = 'exit'): void {
    if (!this.sessionSpan) return
    const s = this.sessionSpan
    s.attributes['session.reason'] = reason
    s.attributes['session.turns'] = this.sessionTotalTurns
    s.attributes['session.llm_calls'] = this.sessionTotalLLMCalls
    s.attributes['session.tool_calls'] = this.sessionTotalToolCalls
    s.attributes['session.input_tokens'] = this.sessionTotalInputTokens
    s.attributes['session.output_tokens'] = this.sessionTotalOutputTokens
    if (this.sessionTotalCachedTokens > 0) s.attributes['session.cached_tokens'] = this.sessionTotalCachedTokens
    if (this.sessionFallbackCount > 0) s.attributes['session.fallback_count'] = this.sessionFallbackCount
    if (this.sessionErrorCount > 0) s.attributes['session.error_count'] = this.sessionErrorCount
    const cost = this.getSessionCost()
    if (cost > 0) s.attributes['session.cost.usd'] = Math.round(cost * 1_000_000) / 1_000_000
    endSpan(s, this.sessionErrorCount > 0 ? 'error' : 'ok')
    this.exporter(s)
    this.sessionSpan = null
  }

  getTraceId(): string {
    return this.traceId
  }

  getSessionCost(): number {
    return this.actualCostFromProvider > 0 ? this.actualCostFromProvider : this.sessionCost
  }

  private calculateCost(inputTokens: number, outputTokens: number): number {
    if (!this.capabilities) return 0
    return (
      inputTokens * this.capabilities.costPerInputToken +
      outputTokens * this.capabilities.costPerOutputToken
    )
  }

  /** Stamps trace-level context onto a freshly created span. */
  private withContext(span: Span): Span {
    if (this.context.sessionId) span.attributes['session.id'] = this.context.sessionId
    if (this.context.agentId) span.attributes['agent.id'] = this.context.agentId
    if (this.context.transport) span.attributes['transport'] = this.context.transport
    if (this.context.userMessage) span.attributes['user.message'] = this.context.userMessage
    return span
  }

  private resetTurnAggregates(): void {
    this.turnInputTokens = 0
    this.turnOutputTokens = 0
    this.turnCachedTokens = 0
    this.turnCost = 0
    this.turnToolsInvoked = 0
    this.turnLLMCalls = 0
  }

  processEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'thinking_start': {
        this.ensureSessionSpan()
        // Open a new agent.turn span only if one isn't already active. The
        // agent loop emits thinking_start once per LLM call, but a single
        // user message can trigger multiple LLM calls (think → tool → think
        // → response). All those LLM calls belong to the same agent turn.
        if (!this.turnSpan) {
          this.turnCount++
          this.resetTurnAggregates()
          // Top-level tracers nest turns under agent.session; sub-agent
          // tracers nest under their delegate span (defaultRootParent).
          const turnParent = this.defaultRootParent || this.sessionSpan?.spanId
          this.turnSpan = this.withContext(
            createSpan(`agent.turn.${this.turnCount}`, turnParent, this.traceId),
          )
          this.turnSpan.attributes['turn.number'] = this.turnCount
        }
        this.turnLLMCalls++
        this.currentLLMSpan = this.withContext(createSpan('llm.generate', this.turnSpan.spanId, this.traceId))
        this.currentLLMSpan.attributes['llm.call_number_in_turn'] = this.turnLLMCalls
        // Compaction effectiveness link: when a context.compact span just
        // closed before this LLM call, attribute the savings here.
        if (this.lastCompactSpanId) {
          this.currentLLMSpan.attributes['context.compaction_parent'] = this.lastCompactSpanId
          this.currentLLMSpan.attributes['context.compaction_saved_tokens'] =
            this.lastCompactBeforeTokens - this.lastCompactAfterTokens
          this.lastCompactSpanId = null
        }
        break
      }

      case 'request_prepared': {
        if (!this.currentLLMSpan) break
        const s = this.currentLLMSpan
        s.attributes['gen_ai.request.model'] = event.model
        s.attributes['gen_ai.system'] = event.provider
        s.attributes['gen_ai.request.system_tokens'] = event.systemTokens
        s.attributes['gen_ai.request.messages_tokens'] = event.messagesTokens
        s.attributes['gen_ai.request.tools_tokens'] = event.toolsTokens
        s.attributes['gen_ai.request.messages_count'] = event.messagesCount
        s.attributes['gen_ai.request.tools_count'] = event.toolsCount
        s.attributes['gen_ai.request.input_tokens_estimate'] = event.totalInputTokensEstimate
        // Mirror onto the turn span so dashboards can read it without joining.
        if (this.turnSpan) {
          this.turnSpan.attributes['request.tokens_estimate'] = event.totalInputTokensEstimate
          this.turnSpan.attributes['request.tools_count'] = event.toolsCount
        }
        break
      }

      case 'thinking_end': {
        if (!this.currentLLMSpan) break
        const s = this.currentLLMSpan
        const { inputTokens, outputTokens, totalTokens, cachedInputTokens, reasoningTokens } = event.tokens
        s.attributes['gen_ai.usage.input_tokens'] = inputTokens
        s.attributes['gen_ai.usage.output_tokens'] = outputTokens
        s.attributes['gen_ai.usage.total_tokens'] = totalTokens
        if (cachedInputTokens !== undefined) s.attributes['gen_ai.usage.cached_input_tokens'] = cachedInputTokens
        if (reasoningTokens !== undefined) s.attributes['gen_ai.usage.reasoning_tokens'] = reasoningTokens
        if (event.model) s.attributes['gen_ai.response.model'] = event.model
        if (event.provider) s.attributes['gen_ai.response.provider'] = event.provider
        if (event.finishReason) s.attributes['gen_ai.response.finish_reason'] = event.finishReason
        if (event.retryCount !== undefined && event.retryCount > 0) {
          s.attributes['http.retry_count'] = event.retryCount
        }
        if (event.generationId) s.attributes['gen_ai.response.id'] = event.generationId
        if (event.latencyMs !== undefined) s.attributes['gen_ai.latency_ms'] = event.latencyMs

        // Transport-level breakdown — splits "where time goes":
        //   gen_ai.latency_ms          = total wall time of generate()
        //   http.latency_ms            = HTTP round-trip
        //   http.ttfb_ms               = time to first byte
        //   http.ttft_ms               = time to first token (streaming only)
        //   delta = gen_ai.latency_ms - http.latency_ms = our overhead
        if (event.transport) {
          const t = event.transport
          if (t.httpLatencyMs !== undefined) s.attributes['http.latency_ms'] = t.httpLatencyMs
          if (t.ttfbMs !== undefined) s.attributes['http.ttfb_ms'] = t.ttfbMs
          if (t.ttftMs !== undefined) s.attributes['http.ttft_ms'] = t.ttftMs
          if (t.requestBytes !== undefined) s.attributes['http.request_bytes'] = t.requestBytes
          if (t.responseBytes !== undefined) s.attributes['http.response_bytes'] = t.responseBytes
          if (t.statusCode !== undefined) s.attributes['http.status_code'] = t.statusCode
          if (t.streamChunks !== undefined) s.attributes['http.stream_chunks'] = t.streamChunks
        }

        // Estimated cost — replaced later if generation_details fires.
        const billableInput = Math.max(0, inputTokens - (cachedInputTokens || 0))
        const cost = this.calculateCost(billableInput, outputTokens)
        if (cost > 0) {
          s.attributes['gen_ai.cost.usd_estimated'] = Math.round(cost * 1_000_000) / 1_000_000
          this.sessionCost += cost
          this.turnCost += cost
        }

        // Per-turn aggregates
        this.turnInputTokens += inputTokens
        this.turnOutputTokens += outputTokens
        this.turnCachedTokens += cachedInputTokens || 0

        endSpan(s, 'ok')
        this.exporter(s)
        this.currentLLMSpan = null
        break
      }

      case 'provider_fallback': {
        // Standalone span — sessions where this fires deserve attention.
        const span = this.withContext(
          createSpan('provider.fallback', this.turnSpan?.spanId || this.defaultRootParent, this.traceId),
        )
        span.attributes['fallback.from'] = event.from
        span.attributes['fallback.to'] = event.to
        span.attributes['fallback.error'] = truncate(event.error, this.payloadLimit)
        endSpan(span, 'error')
        this.exporter(span)
        if (this.turnSpan) {
          this.turnSpan.attributes['fallback.fired'] = true
          this.turnSpan.attributes['fallback.to'] = event.to
        }
        this.sessionFallbackCount++
        break
      }

      case 'generation_details': {
        // Authoritative billing arrived. Emit a tiny standalone span so the
        // value lives next to its llm.generate sibling and is easy to query.
        const span = this.withContext(createSpan('llm.generation_details', this.turnSpan?.spanId, this.traceId))
        span.attributes['gen_ai.response.id'] = event.generationId
        if (event.actualCostUsd !== undefined) {
          span.attributes['gen_ai.cost.usd_actual'] = Math.round(event.actualCostUsd * 1_000_000) / 1_000_000
          this.actualCostFromProvider += event.actualCostUsd
        }
        if (event.cachedInputTokens !== undefined) span.attributes['gen_ai.usage.cached_input_tokens_actual'] = event.cachedInputTokens
        if (event.latencyMs !== undefined) span.attributes['gen_ai.provider.latency_ms'] = event.latencyMs
        if (event.providerName) span.attributes['gen_ai.provider.name'] = event.providerName
        endSpan(span, 'ok')
        this.exporter(span)
        break
      }

      case 'tool_start': {
        const key = event.callId || `${event.tool}:${Date.now()}`
        const span = this.withContext(createSpan(`tool.${event.tool}`, this.turnSpan?.spanId, this.traceId))
        span.attributes['tool.name'] = event.tool
        if (event.callId) span.attributes['tool.call_id'] = event.callId
        try {
          span.attributes['tool.args'] = truncate(JSON.stringify(event.args), this.payloadLimit)
          span.attributes['tool.args_size'] = JSON.stringify(event.args).length
        } catch {
          span.attributes['tool.args'] = '<unserializable>'
        }
        this.currentToolSpans.set(key, span)
        this.turnToolsInvoked++
        break
      }

      case 'tool_result': {
        const key = event.callId || this.findFirstToolKey(event.tool)
        const span = key ? this.currentToolSpans.get(key) : undefined
        if (!span) break
        span.attributes['tool.result_size'] = event.result.length
        span.attributes['tool.result_tokens'] = estimateTokens(event.result)
        span.attributes['tool.result_preview'] = truncate(event.result, this.payloadLimit)
        if (event.latencyMs !== undefined) span.attributes['tool.latency_ms'] = event.latencyMs
        endSpan(span, 'ok')
        this.exporter(span)
        if (key) this.currentToolSpans.delete(key)
        break
      }

      case 'tool_error': {
        const key = event.callId || this.findFirstToolKey(event.tool)
        const span = key ? this.currentToolSpans.get(key) : undefined
        if (!span) break
        span.attributes['tool.error'] = truncate(event.error, this.payloadLimit)
        if (event.latencyMs !== undefined) span.attributes['tool.latency_ms'] = event.latencyMs
        endSpan(span, 'error')
        this.exporter(span)
        if (key) this.currentToolSpans.delete(key)
        break
      }

      case 'tool_denied': {
        const span = this.withContext(createSpan(`tool.${event.tool}.denied`, this.turnSpan?.spanId, this.traceId))
        span.attributes['tool.name'] = event.tool
        span.attributes['tool.denied'] = true
        endSpan(span, 'error')
        this.exporter(span)
        // Close any pending tool span for this tool
        const key = this.findFirstToolKey(event.tool)
        if (key) {
          const pending = this.currentToolSpans.get(key)!
          pending.attributes['tool.denied'] = true
          endSpan(pending, 'error')
          this.exporter(pending)
          this.currentToolSpans.delete(key)
        }
        break
      }

      case 'tool_not_found': {
        const span = this.withContext(createSpan(`tool.${event.tool}.not_found`, this.turnSpan?.spanId, this.traceId))
        span.attributes['tool.name'] = event.tool
        span.attributes['tool.not_found'] = true
        endSpan(span, 'error')
        this.exporter(span)
        break
      }

      case 'context_compacted': {
        // Standalone child span — easier to query than a buried event.
        const span = this.withContext(createSpan('context.compact', this.turnSpan?.spanId, this.traceId))
        span.attributes['context.before_tokens'] = event.before
        span.attributes['context.after_tokens'] = event.after
        span.attributes['context.delta_tokens'] = event.before - event.after
        if (event.phase) span.attributes['context.phase'] = event.phase
        endSpan(span, 'ok')
        this.exporter(span)
        // Remember for the next llm.generate so we can attribute savings.
        this.lastCompactSpanId = span.spanId
        this.lastCompactBeforeTokens = event.before
        this.lastCompactAfterTokens = event.after
        if (this.turnSpan) {
          this.turnSpan.events.push({
            name: 'context.compacted',
            timestamp: Date.now(),
            attributes: { before: event.before, after: event.after, phase: event.phase || 'unknown' },
          })
        }
        break
      }

      case 'cancelled': {
        for (const [key, span] of this.currentToolSpans) {
          span.attributes['cancelled'] = true
          endSpan(span, 'error')
          this.exporter(span)
          this.currentToolSpans.delete(key)
        }
        if (this.turnSpan) {
          this.turnSpan.attributes['cancelled'] = true
          this.attachTurnAggregates()
          endSpan(this.turnSpan, 'error')
          this.exporter(this.turnSpan)
          this.turnSpan = null
        }
        break
      }

      case 'max_turns_reached': {
        if (this.turnSpan) {
          this.turnSpan.attributes['max_turns_reached'] = true
          this.turnSpan.attributes['turns'] = event.turns
          this.attachTurnAggregates()
          endSpan(this.turnSpan, 'error')
          this.exporter(this.turnSpan)
          this.turnSpan = null
        }
        break
      }

      case 'budget_exceeded': {
        if (this.turnSpan) {
          this.turnSpan.attributes['budget_exceeded'] = true
          this.turnSpan.attributes['cost'] = event.cost
          this.attachTurnAggregates()
          endSpan(this.turnSpan, 'error')
          this.exporter(this.turnSpan)
          this.turnSpan = null
        }
        break
      }

      case 'plan_proposed': {
        const span = this.withContext(createSpan('plan.proposed', this.turnSpan?.spanId, this.traceId))
        span.attributes['plan.steps_count'] = event.steps.length
        span.attributes['plan.steps'] = truncate(JSON.stringify(event.steps), this.payloadLimit)
        endSpan(span, 'ok')
        this.exporter(span)
        break
      }

      case 'plan_approved': {
        if (this.turnSpan) {
          this.turnSpan.events.push({ name: 'plan.approved', timestamp: Date.now() })
        }
        break
      }

      case 'plan_rejected': {
        if (this.turnSpan) {
          this.turnSpan.events.push({
            name: 'plan.rejected',
            timestamp: Date.now(),
            attributes: event.reason ? { reason: event.reason } : undefined,
          })
        }
        break
      }

      case 'ask_user': {
        const span = this.withContext(createSpan('agent.ask_user', this.turnSpan?.spanId, this.traceId))
        span.attributes['question'] = truncate(event.question, this.payloadLimit)
        endSpan(span, 'ok')
        this.exporter(span)
        break
      }

      case 'intermediate_response': {
        if (this.turnSpan) {
          this.turnSpan.events.push({
            name: 'intermediate_response',
            timestamp: Date.now(),
            attributes: { length: event.content.length },
          })
        }
        break
      }

      case 'response': {
        if (this.turnSpan) {
          this.turnSpan.attributes['response_length'] = event.content.length
          this.turnSpan.attributes['response_tokens'] = estimateTokens(event.content)
          this.attachTurnAggregates()
          endSpan(this.turnSpan, 'ok')
          this.exporter(this.turnSpan)
          this.turnSpan = null
        }
        break
      }

      case 'error': {
        if (this.turnSpan) {
          this.turnSpan.attributes['error'] = truncate(event.error, this.payloadLimit)
          this.turnSpan.attributes['error.phase'] = event.phase
          this.attachTurnAggregates()
          endSpan(this.turnSpan, 'error')
          this.exporter(this.turnSpan)
          this.turnSpan = null
        }
        break
      }
    }
  }

  /** Find a pending tool span by tool name (used as a fallback when callId
   *  is not available — e.g. older event sources or tool_denied flows). */
  private findFirstToolKey(toolName: string): string | undefined {
    for (const [key, span] of this.currentToolSpans) {
      if (span.attributes['tool.name'] === toolName) return key
    }
    return undefined
  }

  /** Attach per-turn rollups to the agent.turn span before closing it.
   *  Also fold those rollups into the session-level aggregates. */
  private attachTurnAggregates(): void {
    if (!this.turnSpan) return
    this.turnSpan.attributes['turn.input_tokens'] = this.turnInputTokens
    this.turnSpan.attributes['turn.output_tokens'] = this.turnOutputTokens
    if (this.turnCachedTokens > 0) this.turnSpan.attributes['turn.cached_tokens'] = this.turnCachedTokens
    if (this.turnCost > 0) this.turnSpan.attributes['turn.cost.usd_estimated'] = Math.round(this.turnCost * 1_000_000) / 1_000_000
    this.turnSpan.attributes['turn.tools_invoked'] = this.turnToolsInvoked
    this.turnSpan.attributes['turn.llm_calls'] = this.turnLLMCalls
    const sessionCost = this.getSessionCost()
    if (sessionCost > 0) {
      this.turnSpan.attributes['session.cost.usd'] = Math.round(sessionCost * 1_000_000) / 1_000_000
    }

    // Fold into session totals.
    this.sessionTotalTurns++
    this.sessionTotalInputTokens += this.turnInputTokens
    this.sessionTotalOutputTokens += this.turnOutputTokens
    this.sessionTotalCachedTokens += this.turnCachedTokens
    this.sessionTotalToolCalls += this.turnToolsInvoked
    this.sessionTotalLLMCalls += this.turnLLMCalls
    if (this.turnSpan.status === 'error' || this.turnSpan.attributes['error']) {
      this.sessionErrorCount++
    }
  }

  /**
   * Process events from a sub-agent delegation, wrapping them in a parent span.
   * Call this after delegateTask() completes with the collected events.
   */
  processDelegation(agentId: string, task: string, events: AgentEvent[], status: 'completed' | 'failed' | 'timeout'): void {
    const delegateSpan = this.withContext(createSpan(`delegate.${agentId}`, this.turnSpan?.spanId, this.traceId))
    delegateSpan.attributes['delegate.agent_id'] = agentId
    delegateSpan.attributes['delegate.task'] = truncate(task, this.payloadLimit)
    delegateSpan.attributes['delegate.status'] = status

    let subTurnCount = 0
    let subLLMSpan: Span | null = null
    let subToolSpans = new Map<string, Span>()
    let subTurnSpan: Span | null = null

    for (const event of events) {
      switch (event.type) {
        case 'thinking_start': {
          subTurnCount++
          subTurnSpan = this.withContext(createSpan(`delegate.${agentId}.turn.${subTurnCount}`, delegateSpan.spanId, this.traceId))
          subLLMSpan = this.withContext(createSpan('llm.generate', subTurnSpan.spanId, this.traceId))
          break
        }
        case 'thinking_end': {
          if (!subLLMSpan) break
          subLLMSpan.attributes['gen_ai.usage.input_tokens'] = event.tokens.inputTokens
          subLLMSpan.attributes['gen_ai.usage.output_tokens'] = event.tokens.outputTokens
          subLLMSpan.attributes['gen_ai.usage.total_tokens'] = event.tokens.totalTokens
          if (event.model) subLLMSpan.attributes['gen_ai.response.model'] = event.model
          if (event.finishReason) subLLMSpan.attributes['gen_ai.response.finish_reason'] = event.finishReason
          const cost = this.calculateCost(event.tokens.inputTokens, event.tokens.outputTokens)
          if (cost > 0) {
            subLLMSpan.attributes['gen_ai.cost.usd_estimated'] = Math.round(cost * 1_000_000) / 1_000_000
            this.sessionCost += cost
          }
          endSpan(subLLMSpan, 'ok')
          this.exporter(subLLMSpan)
          subLLMSpan = null
          break
        }
        case 'tool_start': {
          const key = event.callId || `${event.tool}:${Date.now()}`
          const span = this.withContext(createSpan(`tool.${event.tool}`, subTurnSpan?.spanId, this.traceId))
          span.attributes['tool.name'] = event.tool
          try {
            span.attributes['tool.args'] = truncate(JSON.stringify(event.args), this.payloadLimit)
          } catch {}
          subToolSpans.set(key, span)
          break
        }
        case 'tool_result': {
          const key = event.callId
          const span = key ? subToolSpans.get(key) : Array.from(subToolSpans.values()).find(s => s.attributes['tool.name'] === event.tool)
          if (!span) break
          span.attributes['tool.result_size'] = event.result.length
          span.attributes['tool.result_preview'] = truncate(event.result, this.payloadLimit)
          endSpan(span, 'ok')
          this.exporter(span)
          if (key) subToolSpans.delete(key)
          break
        }
        case 'tool_error': {
          const key = event.callId
          const span = key ? subToolSpans.get(key) : Array.from(subToolSpans.values()).find(s => s.attributes['tool.name'] === event.tool)
          if (!span) break
          span.attributes['tool.error'] = truncate(event.error, this.payloadLimit)
          endSpan(span, 'error')
          this.exporter(span)
          if (key) subToolSpans.delete(key)
          break
        }
        case 'response': {
          if (subTurnSpan) {
            subTurnSpan.attributes['response_length'] = event.content.length
            endSpan(subTurnSpan, 'ok')
            this.exporter(subTurnSpan)
            subTurnSpan = null
          }
          break
        }
        case 'error': {
          if (subTurnSpan) {
            subTurnSpan.attributes['error'] = truncate(event.error, this.payloadLimit)
            endSpan(subTurnSpan, 'error')
            this.exporter(subTurnSpan)
            subTurnSpan = null
          }
          break
        }
      }
    }

    if (subTurnSpan) { endSpan(subTurnSpan, 'ok'); this.exporter(subTurnSpan) }

    delegateSpan.attributes['delegate.turns'] = subTurnCount
    endSpan(delegateSpan, status === 'completed' ? 'ok' : 'error')
    this.exporter(delegateSpan)
  }
}
