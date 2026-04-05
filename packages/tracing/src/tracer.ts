/**
 * @description Converts AgentEvent stream into tracing spans
 */
import type { AgentEvent, ProviderCapabilities } from '@teya/core'
import { createSpan, endSpan, type Span } from './span.js'

export type TracingExporter = (span: Span) => void

export interface TracerConfig {
  /** Provider capabilities for cost calculation */
  capabilities?: ProviderCapabilities
}

export class AgentTracer {
  private exporter: TracingExporter
  private traceId: string
  private currentLLMSpan: Span | null = null
  private currentToolSpan: Span | null = null
  private turnSpan: Span | null = null
  private turnCount = 0
  private capabilities?: ProviderCapabilities
  private sessionCost = 0

  constructor(exporter: TracingExporter, config?: TracerConfig) {
    this.exporter = exporter
    this.traceId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    this.capabilities = config?.capabilities
  }

  /** Expose traceId so sub-agents can inherit it */
  getTraceId(): string {
    return this.traceId
  }

  /** Get cumulative session cost in USD */
  getSessionCost(): number {
    return this.sessionCost
  }

  /** Calculate cost from token usage and provider capabilities */
  private calculateCost(inputTokens: number, outputTokens: number): number {
    if (!this.capabilities) return 0
    return (
      inputTokens * this.capabilities.costPerInputToken +
      outputTokens * this.capabilities.costPerOutputToken
    )
  }

  processEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'thinking_start': {
        this.turnCount++
        this.turnSpan = createSpan(`agent.turn.${this.turnCount}`, undefined, this.traceId)
        this.currentLLMSpan = createSpan('llm.generate', this.turnSpan.spanId, this.traceId)
        break
      }

      case 'thinking_end': {
        if (this.currentLLMSpan) {
          const { inputTokens, outputTokens, totalTokens } = event.tokens
          this.currentLLMSpan.attributes['gen_ai.usage.input_tokens'] = inputTokens
          this.currentLLMSpan.attributes['gen_ai.usage.output_tokens'] = outputTokens
          this.currentLLMSpan.attributes['gen_ai.usage.total_tokens'] = totalTokens

          // Cost tracking
          const cost = this.calculateCost(inputTokens, outputTokens)
          if (cost > 0) {
            this.currentLLMSpan.attributes['gen_ai.cost.usd'] = Math.round(cost * 1_000_000) / 1_000_000
            this.sessionCost += cost
          }

          endSpan(this.currentLLMSpan, 'ok')
          this.exporter(this.currentLLMSpan)
          this.currentLLMSpan = null
        }
        break
      }

      case 'tool_start': {
        this.currentToolSpan = createSpan(`tool.${event.tool}`, this.turnSpan?.spanId, this.traceId)
        this.currentToolSpan.attributes['tool.name'] = event.tool
        this.currentToolSpan.attributes['tool.args'] = JSON.stringify(event.args).slice(0, 500)
        break
      }

      case 'tool_result': {
        if (this.currentToolSpan) {
          this.currentToolSpan.attributes['tool.result_size'] = event.result.length
          endSpan(this.currentToolSpan, 'ok')
          this.exporter(this.currentToolSpan)
          this.currentToolSpan = null
        }
        break
      }

      case 'tool_error': {
        if (this.currentToolSpan) {
          this.currentToolSpan.attributes['tool.error'] = event.error
          endSpan(this.currentToolSpan, 'error')
          this.exporter(this.currentToolSpan)
          this.currentToolSpan = null
        }
        break
      }

      // ── Denied / security events ──────────────────────────────────────────

      case 'tool_denied': {
        const span = createSpan(`tool.${event.tool}.denied`, this.turnSpan?.spanId, this.traceId)
        span.attributes['tool.name'] = event.tool
        span.attributes['tool.denied'] = true
        endSpan(span, 'error')
        this.exporter(span)
        // Also close any pending tool span for this tool
        if (this.currentToolSpan) {
          this.currentToolSpan.attributes['tool.denied'] = true
          endSpan(this.currentToolSpan, 'error')
          this.exporter(this.currentToolSpan)
          this.currentToolSpan = null
        }
        break
      }

      case 'tool_not_found': {
        const span = createSpan(`tool.${event.tool}.not_found`, this.turnSpan?.spanId, this.traceId)
        span.attributes['tool.name'] = event.tool
        span.attributes['tool.not_found'] = true
        endSpan(span, 'error')
        this.exporter(span)
        break
      }

      // ── Lifecycle events ──────────────────────────────────────────────────

      case 'cancelled': {
        if (this.currentToolSpan) {
          this.currentToolSpan.attributes['cancelled'] = true
          endSpan(this.currentToolSpan, 'error')
          this.exporter(this.currentToolSpan)
          this.currentToolSpan = null
        }
        if (this.turnSpan) {
          this.turnSpan.attributes['cancelled'] = true
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
          endSpan(this.turnSpan, 'error')
          this.exporter(this.turnSpan)
          this.turnSpan = null
        }
        break
      }

      // ── Standard events ───────────────────────────────────────────────────

      case 'response': {
        if (this.turnSpan) {
          this.turnSpan.attributes['response_length'] = event.content.length
          if (this.sessionCost > 0) {
            this.turnSpan.attributes['session_cost.usd'] = Math.round(this.sessionCost * 1_000_000) / 1_000_000
          }
          endSpan(this.turnSpan, 'ok')
          this.exporter(this.turnSpan)
          this.turnSpan = null
        }
        break
      }

      case 'error': {
        if (this.turnSpan) {
          this.turnSpan.attributes['error'] = event.error
          this.turnSpan.attributes['error.phase'] = event.phase
          endSpan(this.turnSpan, 'error')
          this.exporter(this.turnSpan)
          this.turnSpan = null
        }
        break
      }

      case 'context_compacted': {
        if (this.turnSpan) {
          this.turnSpan.events.push({
            name: 'context.compacted',
            timestamp: Date.now(),
            attributes: { before: event.before, after: event.after },
          })
        }
        break
      }
    }
  }

  /**
   * Process events from a sub-agent delegation, wrapping them in a parent span.
   * Call this after delegateTask() completes with the collected events.
   */
  processDelegation(agentId: string, task: string, events: AgentEvent[], status: 'completed' | 'failed' | 'timeout'): void {
    const delegateSpan = createSpan(`delegate.${agentId}`, this.turnSpan?.spanId, this.traceId)
    delegateSpan.attributes['delegate.agent_id'] = agentId
    delegateSpan.attributes['delegate.task'] = task.slice(0, 500)
    delegateSpan.attributes['delegate.status'] = status

    // Create a child tracer to process sub-agent events under this span
    let subTurnCount = 0
    let subLLMSpan: Span | null = null
    let subToolSpan: Span | null = null
    let subTurnSpan: Span | null = null

    for (const event of events) {
      switch (event.type) {
        case 'thinking_start': {
          subTurnCount++
          subTurnSpan = createSpan(`delegate.${agentId}.turn.${subTurnCount}`, delegateSpan.spanId, this.traceId)
          subLLMSpan = createSpan('llm.generate', subTurnSpan.spanId, this.traceId)
          break
        }
        case 'thinking_end': {
          if (subLLMSpan) {
            subLLMSpan.attributes['gen_ai.usage.input_tokens'] = event.tokens.inputTokens
            subLLMSpan.attributes['gen_ai.usage.output_tokens'] = event.tokens.outputTokens
            subLLMSpan.attributes['gen_ai.usage.total_tokens'] = event.tokens.totalTokens
            const cost = this.calculateCost(event.tokens.inputTokens, event.tokens.outputTokens)
            if (cost > 0) {
              subLLMSpan.attributes['gen_ai.cost.usd'] = Math.round(cost * 1_000_000) / 1_000_000
              this.sessionCost += cost
            }
            endSpan(subLLMSpan, 'ok')
            this.exporter(subLLMSpan)
            subLLMSpan = null
          }
          break
        }
        case 'tool_start': {
          subToolSpan = createSpan(`tool.${event.tool}`, subTurnSpan?.spanId, this.traceId)
          subToolSpan.attributes['tool.name'] = event.tool
          endSpan(subToolSpan, 'ok') // We don't have exact timing, mark as instant
          break
        }
        case 'tool_result': {
          if (subToolSpan) {
            subToolSpan.attributes['tool.result_size'] = event.result.length
            this.exporter(subToolSpan)
            subToolSpan = null
          }
          break
        }
        case 'tool_error': {
          if (subToolSpan) {
            subToolSpan.attributes['tool.error'] = event.error
            subToolSpan.status = 'error'
            this.exporter(subToolSpan)
            subToolSpan = null
          }
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
            subTurnSpan.attributes['error'] = event.error
            endSpan(subTurnSpan, 'error')
            this.exporter(subTurnSpan)
            subTurnSpan = null
          }
          break
        }
      }
    }

    // Close any unclosed sub-spans
    if (subTurnSpan) { endSpan(subTurnSpan, 'ok'); this.exporter(subTurnSpan) }

    delegateSpan.attributes['delegate.turns'] = subTurnCount
    endSpan(delegateSpan, status === 'completed' ? 'ok' : 'error')
    this.exporter(delegateSpan)
  }
}
