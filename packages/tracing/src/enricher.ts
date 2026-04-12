/**
 * @description Asynchronously fetches authoritative billing details from a
 * provider's getGenerationDetails() and pipes them back into a tracer as
 * synthetic `generation_details` events.
 *
 * Why this exists: providers like OpenRouter expose actual cost / cached
 * tokens / provider name via a follow-up GET (/api/v1/generation?id=...),
 * but the data only becomes available a few seconds AFTER the response.
 * Blocking the agent loop on that lookup adds tens of seconds of latency
 * across a session. The enricher decouples the lookup from the agent path:
 *
 *   agent-loop.ts ──thinking_end──▶ tracer (records llm.generate)
 *                                   │
 *                          observer in CLI captures generationId
 *                                   │
 *                                   ▼
 *                       GenerationEnricher.enqueue(id)
 *                                   │  (after polling backoff)
 *                                   ▼
 *                       provider.getGenerationDetails(id)
 *                                   │
 *                                   ▼
 *                  tracer.processEvent({type:'generation_details', ...})
 *
 * Architectural rule: this module talks ONLY to LLMProvider and AgentTracer
 * via their public surface. It does not know about CLI, sessions, or files.
 */
import type { LLMProvider, GenerationDetails } from '@teya/core'
import type { AgentTracer } from './tracer.js'

export interface EnricherConfig {
  /** Initial wait before the first lookup attempt (ms). Default 3000. */
  initialDelayMs?: number
  /** Max number of attempts per generationId. Default 6. */
  maxAttempts?: number
  /** Base backoff between attempts (ms). Doubles each attempt, capped at 15s.
   *  Default 2000 → 2s, 4s, 8s, 15s, 15s. */
  backoffMs?: number
}

interface QueueItem {
  generationId: string
  attempts: number
  /** Trace context to restore on the tracer when emitting the late event,
   *  so the synthetic span carries the right session.id. */
  contextSnapshot: { sessionId?: string; agentId?: string; transport?: string }
}

export class GenerationEnricher {
  private provider: LLMProvider
  private tracer: AgentTracer
  private initialDelayMs: number
  private maxAttempts: number
  private backoffMs: number
  private queue: QueueItem[] = []
  private running = false
  private inFlight = 0
  private stopped = false

  constructor(provider: LLMProvider, tracer: AgentTracer, config: EnricherConfig = {}) {
    this.provider = provider
    this.tracer = tracer
    this.initialDelayMs = config.initialDelayMs ?? 3000
    this.maxAttempts = config.maxAttempts ?? 6
    this.backoffMs = config.backoffMs ?? 2000
  }

  /** Schedule a generationId for background billing lookup. */
  enqueue(generationId: string, contextSnapshot: QueueItem['contextSnapshot']): void {
    if (this.stopped) return
    if (!this.provider.getGenerationDetails) return
    if (process.env.TEYA_TRACE_DEBUG) process.stderr.write(`\x1b[90m[enricher] enqueue ${generationId}\x1b[0m\n`)
    this.queue.push({ generationId, attempts: 0, contextSnapshot })
    if (!this.running) this.start()
  }

  /** Drain remaining lookups. Resolves when the queue and in-flight reqs are empty. */
  async drain(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while ((this.queue.length > 0 || this.inFlight > 0) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200))
    }
  }

  stop(): void {
    this.stopped = true
  }

  private start(): void {
    this.running = true
    setTimeout(() => this.tick(), this.initialDelayMs)
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      this.running = false
      return
    }
    const batch = this.queue.splice(0, this.queue.length)
    if (batch.length === 0) {
      this.running = false
      return
    }

    await Promise.all(batch.map(item => this.process(item)))

    if (this.queue.length > 0) {
      // Exponential backoff capped at 15s. attempts is the highest among
      // queued items — be conservative and use the most-retried item's wait.
      const maxAttempts = Math.max(...this.queue.map(i => i.attempts))
      const wait = Math.min(15_000, this.backoffMs * Math.pow(2, maxAttempts))
      setTimeout(() => this.tick(), wait)
    } else {
      this.running = false
    }
  }

  private async process(item: QueueItem): Promise<void> {
    this.inFlight++
    try {
      const lookup = this.provider.getGenerationDetails!(item.generationId)
      const details = await Promise.race<GenerationDetails | null>([
        lookup,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
      ]).catch(() => null)

      if (process.env.TEYA_TRACE_DEBUG) {
        process.stderr.write(
          `\x1b[90m[enricher] ${item.generationId.slice(0, 24)} attempt=${item.attempts} → ${details ? `$${details.actualCostUsd}` : 'null'}\x1b[0m\n`,
        )
      }

      if (details && (details.actualCostUsd !== undefined || details.cachedInputTokens !== undefined)) {
        // Restore the trace context that was active when the LLM call happened
        // so the synthetic span carries the right session.id attribute.
        const prev = this.tracer.getContext()
        this.tracer.setContext(item.contextSnapshot)
        this.tracer.processEvent({
          type: 'generation_details',
          generationId: item.generationId,
          actualCostUsd: details.actualCostUsd,
          cachedInputTokens: details.cachedInputTokens,
          latencyMs: details.latencyMs,
          providerName: details.providerName,
        })
        this.tracer.setContext(prev)
      } else if (item.attempts < this.maxAttempts) {
        item.attempts++
        this.queue.push(item)
      }
    } finally {
      this.inFlight--
    }
  }
}
