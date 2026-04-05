/**
 * @description OTEL-compatible span model — create, end, attributes
 */
export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTime: number  // ms timestamp
  endTime?: number
  duration?: number  // ms
  status: 'ok' | 'error' | 'unset'
  attributes: Record<string, string | number | boolean>
  events: SpanEvent[]
}

export interface SpanEvent {
  name: string
  timestamp: number
  attributes?: Record<string, string | number | boolean>
}

let traceIdCounter = 0
function generateId(): string {
  return Date.now().toString(36) + (++traceIdCounter).toString(36) + Math.random().toString(36).slice(2, 8)
}

export function createSpan(name: string, parentSpanId?: string, traceId?: string): Span {
  return {
    traceId: traceId || generateId(),
    spanId: generateId(),
    parentSpanId,
    name,
    startTime: Date.now(),
    status: 'unset',
    attributes: {},
    events: [],
  }
}

export function endSpan(span: Span, status: 'ok' | 'error' = 'ok'): Span {
  span.endTime = Date.now()
  span.duration = span.endTime - span.startTime
  span.status = status
  return span
}
