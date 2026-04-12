/**
 * @description Read-only query API over per-session jsonl traces.
 *
 * Lives inside @teya/tracing because it operates on the same Span shape
 * the tracer produces. Consumers (CLI viewer, dashboards, eval harness)
 * import from here instead of parsing jsonl by hand.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, basename } from 'path'
import type { Span } from './span.js'

export interface SessionSummary {
  sessionId: string
  agentId?: string
  transport?: string
  firstSeen: number
  lastSeen: number
  spanCount: number
  turnCount: number
  toolInvocations: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedTokens: number
  estimatedCostUsd: number
  actualCostUsd: number
  errorCount: number
  models: string[]
  toolsUsed: string[]
}

export interface CostBreakdown {
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; calls: number }>
  byTool: Record<string, ToolStats>
  bySession: Record<string, number>
  total: { inputTokens: number; outputTokens: number; cachedTokens: number; estimatedUsd: number; actualUsd: number }
}

export interface ToolStats {
  calls: number
  errors: number
  errorRate: number
  resultTokens: number
  /** All individual call latencies in ms — used for percentile computation. */
  latencies: number[]
  totalLatencyMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
}

/** Anomaly detection result — sessions whose cost or token usage stand out. */
export interface AnomalyReport {
  sessions: Array<{
    sessionId: string
    cost: number
    inputTokens: number
    /** Standard deviations above the mean for cost. */
    sigmaCost: number
    /** Standard deviations above the mean for input tokens. */
    sigmaTokens: number
    reason: string
  }>
  meanCost: number
  stdevCost: number
  meanTokens: number
  stdevTokens: number
}

/** Side-by-side diff of two sessions — what changed cost-wise. */
export interface SessionDiff {
  a: SessionSummary
  b: SessionSummary
  costDelta: number
  costDeltaPct: number
  inputTokensDelta: number
  outputTokensDelta: number
  turnsDelta: number
  toolsAdded: string[]
  toolsRemoved: string[]
  modelsChanged: { from: string[]; to: string[] }
}

/** Read all spans from a per-session jsonl file. */
export function loadSessionSpans(baseDir: string, sessionId: string): Span[] {
  const file = join(baseDir, `${sessionId}.jsonl`)
  if (!existsSync(file)) return []
  return parseJsonl(file)
}

/** List every session jsonl in baseDir, with summary stats. */
export function listTracedSessions(baseDir: string): SessionSummary[] {
  if (!existsSync(baseDir)) return []
  const files = readdirSync(baseDir).filter(f => f.endsWith('.jsonl'))
  const summaries: SessionSummary[] = []
  for (const f of files) {
    const sessionId = basename(f, '.jsonl')
    if (sessionId === '_unattributed') continue
    const spans = parseJsonl(join(baseDir, f))
    if (spans.length === 0) continue
    summaries.push(summarizeSpans(sessionId, spans))
  }
  // Sort newest first
  summaries.sort((a, b) => b.lastSeen - a.lastSeen)
  return summaries
}

/** Compute a SessionSummary for a single jsonl file. */
export function summarizeSession(baseDir: string, sessionId: string): SessionSummary | null {
  const spans = loadSessionSpans(baseDir, sessionId)
  if (spans.length === 0) return null
  return summarizeSpans(sessionId, spans)
}

/** Aggregate cost across one or many sessions. Pass an empty array to scan all. */
export function aggregateCost(baseDir: string, sessionIds?: string[]): CostBreakdown {
  const sessions = sessionIds && sessionIds.length > 0
    ? sessionIds.map(id => ({ id, spans: loadSessionSpans(baseDir, id) }))
    : listAllSessions(baseDir)

  const byModel: CostBreakdown['byModel'] = {}
  // Use a temporary accumulator that doesn't yet hold derived percentile fields.
  type ToolAcc = { calls: number; errors: number; resultTokens: number; latencies: number[] }
  const toolAcc: Record<string, ToolAcc> = {}
  const bySession: CostBreakdown['bySession'] = {}
  let totalIn = 0, totalOut = 0, totalCached = 0, totalEst = 0, totalActual = 0

  for (const { id, spans } of sessions) {
    let sessionCost = 0
    let sessionActual = 0
    for (const s of spans) {
      if (s.name === 'llm.generate') {
        const model = (s.attributes['gen_ai.response.model'] || s.attributes['gen_ai.request.model'] || 'unknown') as string
        const inT = (s.attributes['gen_ai.usage.input_tokens'] as number) || 0
        const outT = (s.attributes['gen_ai.usage.output_tokens'] as number) || 0
        const cached = (s.attributes['gen_ai.usage.cached_input_tokens'] as number) || 0
        const cost = (s.attributes['gen_ai.cost.usd_estimated'] as number) || 0
        const m = byModel[model] ||= { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }
        m.inputTokens += inT
        m.outputTokens += outT
        m.costUsd += cost
        m.calls += 1
        totalIn += inT
        totalOut += outT
        totalCached += cached
        totalEst += cost
        sessionCost += cost
      } else if (s.name === 'llm.generation_details') {
        const actual = (s.attributes['gen_ai.cost.usd_actual'] as number) || 0
        totalActual += actual
        sessionActual += actual
      } else if (s.name.startsWith('tool.') && !s.name.endsWith('.denied') && !s.name.endsWith('.not_found')) {
        const toolName = (s.attributes['tool.name'] as string) || s.name.replace(/^tool\./, '')
        const t = toolAcc[toolName] ||= { calls: 0, errors: 0, resultTokens: 0, latencies: [] }
        t.calls += 1
        if (s.status === 'error') t.errors += 1
        t.resultTokens += (s.attributes['tool.result_tokens'] as number) || 0
        if (typeof s.duration === 'number') t.latencies.push(s.duration)
      }
    }
    // Prefer actual cost when available, fall back to estimated.
    const finalSessionCost = sessionActual > 0 ? sessionActual : sessionCost
    if (finalSessionCost > 0) bySession[id] = Math.round(finalSessionCost * 1_000_000) / 1_000_000
  }

  // Compute derived percentile stats per tool.
  const byTool: CostBreakdown['byTool'] = {}
  for (const [name, acc] of Object.entries(toolAcc)) {
    const sorted = [...acc.latencies].sort((a, b) => a - b)
    byTool[name] = {
      calls: acc.calls,
      errors: acc.errors,
      errorRate: acc.calls > 0 ? acc.errors / acc.calls : 0,
      resultTokens: acc.resultTokens,
      latencies: sorted,
      totalLatencyMs: sorted.reduce((s, x) => s + x, 0),
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
    }
  }

  return {
    byModel,
    byTool,
    bySession,
    total: {
      inputTokens: totalIn,
      outputTokens: totalOut,
      cachedTokens: totalCached,
      estimatedUsd: Math.round(totalEst * 1_000_000) / 1_000_000,
      actualUsd: Math.round(totalActual * 1_000_000) / 1_000_000,
    },
  }
}

/** Detect outlier sessions: those whose cost or token usage exceeds N
 *  standard deviations above the mean. Default sigma threshold = 2. */
export function findAnomalies(baseDir: string, sigmaThreshold = 2): AnomalyReport {
  const summaries = listTracedSessions(baseDir)
  if (summaries.length < 3) {
    return { sessions: [], meanCost: 0, stdevCost: 0, meanTokens: 0, stdevTokens: 0 }
  }
  const costs = summaries.map(s => s.actualCostUsd > 0 ? s.actualCostUsd : s.estimatedCostUsd)
  const tokens = summaries.map(s => s.totalInputTokens)
  const meanCost = mean(costs)
  const stdevCost = stdev(costs, meanCost)
  const meanTokens = mean(tokens)
  const stdevTokens = stdev(tokens, meanTokens)

  const flagged: AnomalyReport['sessions'] = []
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i]
    const cost = costs[i]
    const tok = tokens[i]
    const sigmaCost = stdevCost > 0 ? (cost - meanCost) / stdevCost : 0
    const sigmaTokens = stdevTokens > 0 ? (tok - meanTokens) / stdevTokens : 0
    const reasons: string[] = []
    if (sigmaCost >= sigmaThreshold) reasons.push(`cost ${sigmaCost.toFixed(1)}σ`)
    if (sigmaTokens >= sigmaThreshold) reasons.push(`tokens ${sigmaTokens.toFixed(1)}σ`)
    if (s.errorCount > 0) reasons.push(`${s.errorCount} errors`)
    if (reasons.length > 0) {
      flagged.push({
        sessionId: s.sessionId,
        cost,
        inputTokens: tok,
        sigmaCost,
        sigmaTokens,
        reason: reasons.join(', '),
      })
    }
  }
  flagged.sort((a, b) => Math.max(b.sigmaCost, b.sigmaTokens) - Math.max(a.sigmaCost, a.sigmaTokens))
  return { sessions: flagged, meanCost, stdevCost, meanTokens, stdevTokens }
}

/** Compare two sessions side-by-side. Useful for "this query used to be cheap". */
export function diffSessions(baseDir: string, idA: string, idB: string): SessionDiff | null {
  const a = summarizeSession(baseDir, idA)
  const b = summarizeSession(baseDir, idB)
  if (!a || !b) return null
  const aCost = a.actualCostUsd > 0 ? a.actualCostUsd : a.estimatedCostUsd
  const bCost = b.actualCostUsd > 0 ? b.actualCostUsd : b.estimatedCostUsd
  const aTools = new Set(a.toolsUsed)
  const bTools = new Set(b.toolsUsed)
  return {
    a,
    b,
    costDelta: bCost - aCost,
    costDeltaPct: aCost > 0 ? ((bCost - aCost) / aCost) * 100 : 0,
    inputTokensDelta: b.totalInputTokens - a.totalInputTokens,
    outputTokensDelta: b.totalOutputTokens - a.totalOutputTokens,
    turnsDelta: b.turnCount - a.turnCount,
    toolsAdded: [...bTools].filter(t => !aTools.has(t)),
    toolsRemoved: [...aTools].filter(t => !bTools.has(t)),
    modelsChanged: { from: a.models, to: b.models },
  }
}

// Statistics helpers
function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, x) => s + x, 0) / xs.length
}
function stdev(xs: number[], avg?: number): number {
  if (xs.length === 0) return 0
  const m = avg ?? mean(xs)
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length
  return Math.sqrt(variance)
}
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

// ── Internals ──────────────────────────────────────────────────────────────

function parseJsonl(file: string): Span[] {
  try {
    const text = readFileSync(file, 'utf-8')
    const out: Span[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { out.push(JSON.parse(trimmed)) } catch {}
    }
    return out
  } catch {
    return []
  }
}

function listAllSessions(baseDir: string): Array<{ id: string; spans: Span[] }> {
  if (!existsSync(baseDir)) return []
  return readdirSync(baseDir)
    .filter(f => f.endsWith('.jsonl') && f !== '_unattributed.jsonl')
    .map(f => ({
      id: basename(f, '.jsonl'),
      spans: parseJsonl(join(baseDir, f)),
    }))
    .filter(s => s.spans.length > 0)
}

function summarizeSpans(sessionId: string, spans: Span[]): SessionSummary {
  let firstSeen = Infinity
  let lastSeen = 0
  let turnCount = 0
  let toolInvocations = 0
  let totalIn = 0, totalOut = 0, totalCached = 0
  let estCost = 0, actualCost = 0
  let errors = 0
  const models = new Set<string>()
  const toolsUsed = new Set<string>()
  let agentId: string | undefined
  let transport: string | undefined

  for (const s of spans) {
    if (s.startTime < firstSeen) firstSeen = s.startTime
    if ((s.endTime || s.startTime) > lastSeen) lastSeen = s.endTime || s.startTime
    if (!agentId && s.attributes['agent.id']) agentId = s.attributes['agent.id'] as string
    if (!transport && s.attributes['transport']) transport = s.attributes['transport'] as string
    if (s.status === 'error') errors++

    if (s.name.startsWith('agent.turn.')) turnCount++

    if (s.name === 'llm.generate') {
      const model = (s.attributes['gen_ai.response.model'] || s.attributes['gen_ai.request.model']) as string | undefined
      if (model) models.add(model)
      totalIn += (s.attributes['gen_ai.usage.input_tokens'] as number) || 0
      totalOut += (s.attributes['gen_ai.usage.output_tokens'] as number) || 0
      totalCached += (s.attributes['gen_ai.usage.cached_input_tokens'] as number) || 0
      estCost += (s.attributes['gen_ai.cost.usd_estimated'] as number) || 0
    }

    if (s.name === 'llm.generation_details') {
      actualCost += (s.attributes['gen_ai.cost.usd_actual'] as number) || 0
    }

    if (s.name.startsWith('tool.') && !s.name.endsWith('.denied') && !s.name.endsWith('.not_found')) {
      toolInvocations++
      const t = s.attributes['tool.name'] as string | undefined
      if (t) toolsUsed.add(t)
    }
  }

  return {
    sessionId,
    agentId,
    transport,
    firstSeen: firstSeen === Infinity ? 0 : firstSeen,
    lastSeen,
    spanCount: spans.length,
    turnCount,
    toolInvocations,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    totalCachedTokens: totalCached,
    estimatedCostUsd: Math.round(estCost * 1_000_000) / 1_000_000,
    actualCostUsd: Math.round(actualCost * 1_000_000) / 1_000_000,
    errorCount: errors,
    models: [...models],
    toolsUsed: [...toolsUsed],
  }
}
