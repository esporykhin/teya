/**
 * @description Re-exports all tracing modules
 */
export { createSpan, endSpan, type Span, type SpanEvent } from './span.js'
export { AgentTracer, type TracingExporter, type TracerConfig, type TraceContext } from './tracer.js'
export {
  consoleExporter,
  jsonExporter,
  sessionFileExporter,
  otlpExporter,
  compositeExporter,
  noopExporter,
} from './exporters.js'
export {
  loadSessionSpans,
  listTracedSessions,
  summarizeSession,
  aggregateCost,
  findAnomalies,
  diffSessions,
  type SessionSummary,
  type CostBreakdown,
  type ToolStats,
  type AnomalyReport,
  type SessionDiff,
} from './query.js'
export { GenerationEnricher, type EnricherConfig } from './enricher.js'
