/**
 * @description Span exporters — console (stderr), JSON file, OTLP HTTP, noop
 */
import type { Span } from './span.js'

// ── Console exporter — colored output to stderr ─────────────────────────────

export function consoleExporter(span: Span): void {
  const duration = span.duration ? `${span.duration}ms` : '?'
  const status = span.status === 'error' ? '\x1b[31mERR\x1b[0m' : '\x1b[32mOK\x1b[0m'
  const tokens = span.attributes['gen_ai.usage.total_tokens'] || ''
  const cost = span.attributes['gen_ai.cost.usd']
  const extra = [
    tokens ? `${tokens} tokens` : '',
    cost ? `$${cost}` : '',
  ].filter(Boolean).join(', ')
  const suffix = extra ? ` [${extra}]` : ''

  process.stderr.write(
    `\x1b[90m[trace]\x1b[0m ${span.name} ${status} ${duration}${suffix}\n`
  )
}

// ── JSON exporter — append to file ──────────────────────────────────────────

import { appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

export function jsonExporter(filePath: string): (span: Span) => void {
  mkdirSync(dirname(filePath), { recursive: true })
  return (span: Span) => {
    appendFileSync(filePath, JSON.stringify(span) + '\n', 'utf-8')
  }
}

/**
 * Routes spans into per-session jsonl files based on the `session.id` attribute.
 * Spans without a session id fall back to `_unattributed.jsonl`. This is the
 * primary exporter for `teya trace show <session>` — it makes per-session
 * lookups O(1) instead of grepping a single growing daily file.
 */
export function sessionFileExporter(baseDir: string): (span: Span) => void {
  mkdirSync(baseDir, { recursive: true })
  return (span: Span) => {
    const sessionId = (span.attributes['session.id'] as string) || '_unattributed'
    const file = join(baseDir, `${sessionId}.jsonl`)
    appendFileSync(file, JSON.stringify(span) + '\n', 'utf-8')
  }
}

// ── OTLP HTTP exporter — sends spans to OpenTelemetry collector ─────────────

/**
 * Exports spans via OTLP/HTTP JSON to any OTEL-compatible backend:
 * Jaeger, Grafana Tempo, Datadog, etc.
 *
 * Default endpoint: http://localhost:4318/v1/traces
 *
 * Batches spans and flushes every 5 seconds or when batch reaches 20 spans.
 */
export function otlpExporter(
  endpoint: string = 'http://localhost:4318/v1/traces',
  options?: { batchSize?: number; flushIntervalMs?: number; headers?: Record<string, string> },
): (span: Span) => void {
  const batchSize = options?.batchSize ?? 20
  const flushIntervalMs = options?.flushIntervalMs ?? 5000
  const headers = options?.headers ?? {}
  let batch: Span[] = []
  let flushTimer: ReturnType<typeof setInterval> | null = null

  function toOTLPSpan(span: Span) {
    // Convert ms timestamps to nanoseconds (OTLP format)
    const startTimeUnixNano = String(span.startTime * 1_000_000)
    const endTimeUnixNano = span.endTime ? String(span.endTime * 1_000_000) : startTimeUnixNano

    const attributes = Object.entries(span.attributes).map(([key, value]) => {
      if (typeof value === 'number') {
        return { key, value: { intValue: String(Math.round(value)) } }
      }
      if (typeof value === 'boolean') {
        return { key, value: { boolValue: value } }
      }
      return { key, value: { stringValue: String(value) } }
    })

    const events = span.events.map(e => ({
      timeUnixNano: String(e.timestamp * 1_000_000),
      name: e.name,
      attributes: e.attributes
        ? Object.entries(e.attributes).map(([key, value]) => ({
            key,
            value: typeof value === 'number'
              ? { intValue: String(Math.round(value)) }
              : { stringValue: String(value) },
          }))
        : [],
    }))

    return {
      traceId: hexEncode(span.traceId),
      spanId: hexEncode(span.spanId),
      parentSpanId: span.parentSpanId ? hexEncode(span.parentSpanId) : undefined,
      name: span.name,
      kind: 1, // SPAN_KIND_INTERNAL
      startTimeUnixNano,
      endTimeUnixNano,
      attributes,
      events,
      status: {
        code: span.status === 'error' ? 2 : span.status === 'ok' ? 1 : 0,
        message: span.status === 'error' ? (span.attributes['error'] as string || '') : '',
      },
    }
  }

  async function flush() {
    if (batch.length === 0) return
    const spans = batch.splice(0)

    const payload = {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'teya-agent' } },
          ],
        },
        scopeSpans: [{
          scope: { name: '@teya/tracing', version: '1.0.0' },
          spans: spans.map(toOTLPSpan),
        }],
      }],
    }

    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(payload),
      })
    } catch {
      // Silently drop — tracing should never break the agent
      process.stderr.write(`\x1b[90m[trace] OTLP export failed to ${endpoint}\x1b[0m\n`)
    }
  }

  // Start periodic flush
  flushTimer = setInterval(flush, flushIntervalMs)
  if (flushTimer.unref) flushTimer.unref() // Don't keep process alive

  // Flush on exit
  process.on('beforeExit', () => { flush() })

  return (span: Span) => {
    batch.push(span)
    if (batch.length >= batchSize) {
      flush()
    }
  }
}

/** Convert base36 ID to hex string (padded to 32 chars for traceId, 16 for spanId) */
function hexEncode(id: string): string {
  // Use a hash-like approach: convert each char code to hex
  let hex = ''
  for (let i = 0; i < id.length; i++) {
    hex += id.charCodeAt(i).toString(16).padStart(2, '0')
  }
  // Pad/truncate to required length (32 for traceId is fine, OTLP accepts variable)
  return hex.padStart(16, '0').slice(0, 32)
}

// ── Composite exporter — fan-out to multiple exporters ──────────────────────

export function compositeExporter(...exporters: Array<(span: Span) => void>): (span: Span) => void {
  return (span: Span) => {
    for (const exp of exporters) {
      exp(span)
    }
  }
}

// ── NOOP exporter ───────────────────────────────────────────────────────────

export function noopExporter(_span: Span): void {}
