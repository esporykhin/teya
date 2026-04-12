/**
 * @description `teya trace` subcommands — read-only viewer over per-session jsonl traces.
 *
 * Reads from CONFIG_DIR/traces/sessions/<id>.jsonl. All logic lives in
 * @teya/tracing query.ts; this file is just CLI UX (parse args, print).
 */
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, readFileSync } from 'fs'
import {
  listTracedSessions,
  loadSessionSpans,
  summarizeSession,
  aggregateCost,
  findAnomalies,
  diffSessions,
} from '@teya/tracing'
import type { Span } from '@teya/tracing'

const CONFIG_DIR = join(homedir(), '.teya')
const SESSIONS_DIR = join(CONFIG_DIR, 'traces', 'sessions')

const colors = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${(n * 1000).toFixed(3)}m` // millicents
  return `$${n.toFixed(4)}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtAge(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

// ── teya trace list ──────────────────────────────────────────────────────────
function cmdList(args: string[]): void {
  const limit = parseInt(args.find((_, i) => args[i - 1] === '--limit') || '20', 10)
  const sessions = listTracedSessions(SESSIONS_DIR).slice(0, limit)
  if (sessions.length === 0) {
    console.log(colors.dim('No traced sessions yet. Run teya, send a message, then try again.'))
    return
  }
  console.log(colors.bold(`${sessions.length} session(s) in ${SESSIONS_DIR}\n`))
  console.log(
    colors.dim(
      'session   age        turns  tools  in→out tokens     cached  est$       actual$    model'
    )
  )
  for (const s of sessions) {
    const id = s.sessionId.slice(0, 8)
    const age = fmtAge(s.lastSeen).padEnd(10)
    const turns = String(s.turnCount).padStart(5)
    const tools = String(s.toolInvocations).padStart(5)
    const tokens = `${fmtTokens(s.totalInputTokens)}→${fmtTokens(s.totalOutputTokens)}`.padEnd(16)
    const cached = fmtTokens(s.totalCachedTokens).padStart(6)
    const est = fmtUsd(s.estimatedCostUsd).padEnd(10)
    const act = (s.actualCostUsd > 0 ? fmtUsd(s.actualCostUsd) : '-').padEnd(10)
    const model = s.models[0] || '-'
    const status = s.errorCount > 0 ? colors.red(`✗${s.errorCount}`) : ''
    console.log(`${colors.cyan(id)}  ${age} ${turns}  ${tools}  ${tokens}  ${cached}  ${est} ${act} ${model} ${status}`)
  }
  console.log(colors.dim('\nteya trace show <id>     — full span tree for one session'))
  console.log(colors.dim('teya trace cost           — aggregate cost across all sessions'))
}

// ── teya trace show <session-id> [--json] ────────────────────────────────────
function cmdShow(args: string[]): void {
  const wanted = args[0]
  if (!wanted) {
    console.error(colors.red('Usage: teya trace show <session-id-prefix> [--json]'))
    process.exit(1)
  }
  const jsonOutput = args.includes('--json')

  const allSessions = listTracedSessions(SESSIONS_DIR)
  const session = allSessions.find(s => s.sessionId.startsWith(wanted))
  if (!session) {
    console.error(colors.red(`No session found matching "${wanted}"`))
    process.exit(1)
  }

  const spans = loadSessionSpans(SESSIONS_DIR, session.sessionId)
  const summary = summarizeSession(SESSIONS_DIR, session.sessionId)!

  if (jsonOutput) {
    // Machine-readable: pipe to jq, store in DB, ship to dashboards.
    process.stdout.write(JSON.stringify({ summary, spans }, null, 2) + '\n')
    return
  }

  console.log(colors.bold(`Session ${colors.cyan(session.sessionId)}`))
  console.log(
    colors.dim(
      `  agent=${summary.agentId || '-'}  transport=${summary.transport || '-'}  spans=${summary.spanCount}  errors=${summary.errorCount}`
    )
  )
  console.log(
    colors.dim(
      `  turns=${summary.turnCount}  tools=${summary.toolInvocations}  in=${fmtTokens(summary.totalInputTokens)}  out=${fmtTokens(summary.totalOutputTokens)}  cached=${fmtTokens(summary.totalCachedTokens)}`
    )
  )
  console.log(
    colors.dim(
      `  cost: estimated ${fmtUsd(summary.estimatedCostUsd)}  actual ${summary.actualCostUsd > 0 ? fmtUsd(summary.actualCostUsd) : 'n/a'}`
    )
  )
  console.log(colors.dim(`  models: ${summary.models.join(', ') || '-'}`))
  console.log(colors.dim(`  tools: ${summary.toolsUsed.join(', ') || '-'}`))
  console.log()

  // Group spans by turn
  const turnSpans: Span[] = spans.filter(s => s.name.startsWith('agent.turn.'))
  turnSpans.sort((a, b) => a.startTime - b.startTime)

  for (const turn of turnSpans) {
    const userMsg = (turn.attributes['user.message'] as string) || ''
    const turnNum = turn.attributes['turn.number'] || '?'
    const tokensIn = turn.attributes['turn.input_tokens'] || 0
    const tokensOut = turn.attributes['turn.output_tokens'] || 0
    const cost = turn.attributes['turn.cost.usd_estimated'] || 0
    const toolsCount = turn.attributes['turn.tools_invoked'] || 0
    const llmCalls = turn.attributes['turn.llm_calls'] || 0
    const status = turn.status === 'error' ? colors.red('✗') : colors.green('✓')

    console.log(
      `${status} ${colors.bold(`turn ${turnNum}`)}  ${fmtDuration(turn.duration)}  llm=${llmCalls} tools=${toolsCount}  in=${fmtTokens(tokensIn as number)} out=${fmtTokens(tokensOut as number)} ${fmtUsd(cost as number)}`
    )
    if (userMsg) console.log(`   ${colors.dim('»')} ${userMsg.slice(0, 120).replace(/\n/g, ' ')}`)

    // Children of this turn
    const children = spans
      .filter(s => s.parentSpanId === turn.spanId)
      .sort((a, b) => a.startTime - b.startTime)

    for (const c of children) {
      const cstatus = c.status === 'error' ? colors.red('✗') : colors.dim('·')
      if (c.name === 'llm.generate') {
        const model = c.attributes['gen_ai.response.model'] || c.attributes['gen_ai.request.model'] || '-'
        const inT = c.attributes['gen_ai.usage.input_tokens'] || 0
        const outT = c.attributes['gen_ai.usage.output_tokens'] || 0
        const cached = c.attributes['gen_ai.usage.cached_input_tokens'] || 0
        const finish = c.attributes['gen_ai.response.finish_reason'] || ''
        const retries = c.attributes['http.retry_count'] || 0
        const breakdown = `sys=${fmtTokens(c.attributes['gen_ai.request.system_tokens'] as number || 0)} msgs=${fmtTokens(c.attributes['gen_ai.request.messages_tokens'] as number || 0)} tools=${fmtTokens(c.attributes['gen_ai.request.tools_tokens'] as number || 0)}`
        console.log(`   ${cstatus} ${colors.cyan('llm.generate')} ${model} ${fmtDuration(c.duration)}  in=${fmtTokens(inT as number)} out=${fmtTokens(outT as number)} cached=${fmtTokens(cached as number)} ${finish}${retries ? ` retries=${retries}` : ''}`)
        console.log(`     ${colors.dim(breakdown)}`)
        // Transport breakdown — split network from total to spot slow providers vs slow code.
        const httpMs = c.attributes['http.latency_ms']
        const ttfb = c.attributes['http.ttfb_ms']
        const reqB = c.attributes['http.request_bytes']
        const respB = c.attributes['http.response_bytes']
        if (httpMs !== undefined) {
          console.log(
            `     ${colors.dim(`http=${fmtDuration(httpMs as number)} ttfb=${fmtDuration(ttfb as number | undefined)} ↑${fmtBytes(reqB as number || 0)} ↓${fmtBytes(respB as number || 0)}`)}`,
          )
        }
        // Compaction effectiveness link.
        const savedTokens = c.attributes['context.compaction_saved_tokens']
        if (savedTokens !== undefined) {
          console.log(`     ${colors.dim(`(after compact: saved ${fmtTokens(savedTokens as number)} tokens)`)}`)
        }
      } else if (c.name === 'llm.generation_details') {
        const actual = c.attributes['gen_ai.cost.usd_actual'] || 0
        const provName = c.attributes['gen_ai.provider.name'] || '-'
        console.log(`   ${cstatus} ${colors.dim('└─ actual:')} ${fmtUsd(actual as number)} via ${provName}`)
      } else if (c.name === 'context.compact') {
        const before = c.attributes['context.before_tokens'] || 0
        const after = c.attributes['context.after_tokens'] || 0
        const phase = c.attributes['context.phase'] || '?'
        console.log(`   ${cstatus} ${colors.yellow('context.compact')} ${phase}  ${fmtTokens(before as number)} → ${fmtTokens(after as number)}`)
      } else if (c.name === 'provider.fallback') {
        const from = c.attributes['fallback.from'] || '?'
        const to = c.attributes['fallback.to'] || '?'
        const err = c.attributes['fallback.error'] as string | undefined
        console.log(`   ${colors.red('!')} ${colors.red('provider.fallback')} ${from} → ${to}`)
        if (err) console.log(`     ${colors.red(`error: ${err.slice(0, 200)}`)}`)
      } else if (c.name.startsWith('delegate.')) {
        const subAgent = c.attributes['delegate.agent_id'] || '?'
        const subTurns = c.attributes['delegate.turns'] || 0
        const subCost = c.attributes['delegate.cost.usd'] || 0
        const dstatus = c.attributes['delegate.status'] || '?'
        console.log(`   ${cstatus} ${colors.cyan(`delegate.${subAgent}`)} ${fmtDuration(c.duration)}  turns=${subTurns} ${fmtUsd(subCost as number)} ${dstatus}`)
      } else if (c.name.startsWith('tool.')) {
        const tname = c.attributes['tool.name'] || c.name.replace(/^tool\./, '')
        const resTokens = c.attributes['tool.result_tokens'] || 0
        const args = (c.attributes['tool.args'] as string || '').slice(0, 80).replace(/\n/g, ' ')
        const err = c.attributes['tool.error'] as string | undefined
        console.log(`   ${cstatus} ${colors.green(`tool.${tname}`)} ${fmtDuration(c.duration)} result=${fmtTokens(resTokens as number)}t`)
        if (args) console.log(`     ${colors.dim(`args: ${args}`)}`)
        if (err) console.log(`     ${colors.red(`error: ${err.slice(0, 200)}`)}`)
      } else if (c.name === 'plan.proposed') {
        const steps = c.attributes['plan.steps_count'] || 0
        console.log(`   ${cstatus} ${colors.yellow('plan.proposed')} ${steps} steps`)
      }
    }
    console.log()
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
  return `${(n / 1024 / 1024).toFixed(2)}M`
}

// ── teya trace cost [--by-tool|--by-model|--by-session] [--since=24h] ────────
function cmdCost(args: string[]): void {
  const breakdown = aggregateCost(SESSIONS_DIR)
  const groupBy = args.includes('--by-tool')
    ? 'tool'
    : args.includes('--by-session')
      ? 'session'
      : 'model'

  console.log(colors.bold('Cost summary across all traced sessions\n'))
  console.log(
    `total: in=${fmtTokens(breakdown.total.inputTokens)} out=${fmtTokens(breakdown.total.outputTokens)} cached=${fmtTokens(breakdown.total.cachedTokens)}  est=${fmtUsd(breakdown.total.estimatedUsd)}  actual=${fmtUsd(breakdown.total.actualUsd)}`
  )
  console.log()

  if (groupBy === 'model') {
    console.log(colors.bold('By model:'))
    const rows = Object.entries(breakdown.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd)
    for (const [model, m] of rows) {
      console.log(
        `  ${model.padEnd(40)} ${String(m.calls).padStart(5)} calls  in=${fmtTokens(m.inputTokens).padStart(7)} out=${fmtTokens(m.outputTokens).padStart(7)}  ${fmtUsd(m.costUsd)}`
      )
    }
  } else if (groupBy === 'tool') {
    console.log(colors.bold('By tool (latency percentiles in ms):'))
    console.log(
      colors.dim('  tool                              calls  err%   p50    p95    p99    result tokens'),
    )
    const rows = Object.entries(breakdown.byTool).sort((a, b) => b[1].calls - a[1].calls)
    for (const [tool, t] of rows) {
      const errPct = (t.errorRate * 100).toFixed(0).padStart(3) + '%'
      const errColor = t.errorRate > 0.1 ? colors.red : t.errorRate > 0 ? colors.yellow : colors.dim
      console.log(
        `  ${tool.padEnd(32)} ${String(t.calls).padStart(5)}  ${errColor(errPct)}  ${String(Math.round(t.p50Ms)).padStart(5)}  ${String(Math.round(t.p95Ms)).padStart(5)}  ${String(Math.round(t.p99Ms)).padStart(5)}  ${fmtTokens(t.resultTokens).padStart(7)}t`,
      )
    }
  } else {
    console.log(colors.bold('By session:'))
    const rows = Object.entries(breakdown.bySession).sort((a, b) => b[1] - a[1])
    for (const [id, c] of rows.slice(0, 30)) {
      console.log(`  ${colors.cyan(id.slice(0, 8))}  ${fmtUsd(c)}`)
    }
  }
}

// ── teya trace tail — follow today's daily jsonl with running totals ─────────
async function cmdTail(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const file = join(CONFIG_DIR, 'traces', `${today}.jsonl`)
  if (!existsSync(file)) {
    console.log(colors.dim(`No trace file yet at ${file}`))
    return
  }
  console.log(colors.dim(`tailing ${file} (Ctrl+C to stop)\n`))

  // Running totals across the tail session — printed below each event so
  // you watch cost climb in real time as the agent works.
  const totals = { llmCalls: 0, toolCalls: 0, inTokens: 0, outTokens: 0, costEst: 0, costActual: 0, errors: 0 }
  let pos = 0

  const printTotals = () => {
    process.stdout.write(
      colors.dim(`  total: llm=${totals.llmCalls} tools=${totals.toolCalls} in=${fmtTokens(totals.inTokens)} out=${fmtTokens(totals.outTokens)} est=${fmtUsd(totals.costEst)} actual=${fmtUsd(totals.costActual)} err=${totals.errors}\n`),
    )
  }

  const print = () => {
    try {
      const buf = readFileSync(file, 'utf-8')
      if (buf.length > pos) {
        const slice = buf.slice(pos)
        pos = buf.length
        for (const line of slice.split('\n')) {
          if (!line.trim()) continue
          try {
            const span = JSON.parse(line) as Span
            const sid = ((span.attributes['session.id'] as string) || '------').slice(0, 6)
            const status = span.status === 'error' ? colors.red('✗') : colors.green('✓')
            const dur = fmtDuration(span.duration)
            let extra = ''
            if (span.name === 'llm.generate') {
              totals.llmCalls++
              totals.inTokens += (span.attributes['gen_ai.usage.input_tokens'] as number) || 0
              totals.outTokens += (span.attributes['gen_ai.usage.output_tokens'] as number) || 0
              totals.costEst += (span.attributes['gen_ai.cost.usd_estimated'] as number) || 0
              const model = (span.attributes['gen_ai.response.model'] as string) || ''
              extra = ` ${model.slice(0, 30)}`
            } else if (span.name === 'llm.generation_details') {
              totals.costActual += (span.attributes['gen_ai.cost.usd_actual'] as number) || 0
            } else if (span.name.startsWith('tool.') && !span.name.endsWith('.denied') && !span.name.endsWith('.not_found')) {
              totals.toolCalls++
            }
            if (span.status === 'error') totals.errors++
            console.log(`${colors.dim(sid)} ${status} ${span.name.padEnd(28)} ${dur}${extra}`)
            // Print rollup after every "interesting" span (turn close, llm call, tool).
            if (span.name === 'llm.generate' || span.name.startsWith('agent.turn')) {
              printTotals()
            }
          } catch {}
        }
      }
    } catch {}
  }
  print()
  setInterval(print, 500)
}

// ── teya trace anomalies — find sessions with outlier cost/tokens ────────────
function cmdAnomalies(args: string[]): void {
  const sigmaArg = args.find(a => a.startsWith('--sigma='))
  const sigma = sigmaArg ? parseFloat(sigmaArg.slice('--sigma='.length)) : 2
  const report = findAnomalies(SESSIONS_DIR, sigma)
  console.log(colors.bold(`Anomaly report (threshold ${sigma}σ above mean)\n`))
  console.log(
    colors.dim(`baseline: cost mean=${fmtUsd(report.meanCost)} stdev=${fmtUsd(report.stdevCost)}  tokens mean=${fmtTokens(report.meanTokens)} stdev=${fmtTokens(report.stdevTokens)}\n`),
  )
  if (report.sessions.length === 0) {
    console.log(colors.green('No outliers — all sessions within bounds.'))
    return
  }
  for (const s of report.sessions) {
    console.log(
      `${colors.cyan(s.sessionId.slice(0, 8))}  ${fmtUsd(s.cost).padEnd(10)}  in=${fmtTokens(s.inputTokens).padStart(7)}  ${colors.yellow(s.reason)}`,
    )
  }
  console.log(colors.dim(`\nteya trace show <id>     # drill into one`))
}

// ── teya trace diff <a> <b> — side-by-side comparison ────────────────────────
function cmdDiff(args: string[]): void {
  const [aArg, bArg] = args
  if (!aArg || !bArg) {
    console.error(colors.red('Usage: teya trace diff <session-a> <session-b>'))
    process.exit(1)
  }
  const all = listTracedSessions(SESSIONS_DIR)
  const aSes = all.find(s => s.sessionId.startsWith(aArg))
  const bSes = all.find(s => s.sessionId.startsWith(bArg))
  if (!aSes || !bSes) {
    console.error(colors.red('One of the session ids did not match.'))
    process.exit(1)
  }
  const diff = diffSessions(SESSIONS_DIR, aSes.sessionId, bSes.sessionId)
  if (!diff) {
    console.error(colors.red('Could not load both sessions.'))
    process.exit(1)
  }

  const sign = (n: number) => (n > 0 ? colors.red(`+${n}`) : n < 0 ? colors.green(String(n)) : '0')
  const signCost = (n: number) => (n > 0 ? colors.red(`+${fmtUsd(Math.abs(n))}`) : n < 0 ? colors.green(`-${fmtUsd(Math.abs(n))}`) : fmtUsd(0))

  console.log(colors.bold(`Diff: ${colors.cyan(diff.a.sessionId.slice(0, 8))}  →  ${colors.cyan(diff.b.sessionId.slice(0, 8))}\n`))
  console.log(`cost          ${fmtUsd(diff.a.actualCostUsd || diff.a.estimatedCostUsd).padEnd(12)} ${fmtUsd(diff.b.actualCostUsd || diff.b.estimatedCostUsd).padEnd(12)} ${signCost(diff.costDelta)} (${diff.costDeltaPct > 0 ? '+' : ''}${diff.costDeltaPct.toFixed(0)}%)`)
  console.log(`input tokens  ${fmtTokens(diff.a.totalInputTokens).padEnd(12)} ${fmtTokens(diff.b.totalInputTokens).padEnd(12)} ${sign(diff.inputTokensDelta)}`)
  console.log(`output tokens ${fmtTokens(diff.a.totalOutputTokens).padEnd(12)} ${fmtTokens(diff.b.totalOutputTokens).padEnd(12)} ${sign(diff.outputTokensDelta)}`)
  console.log(`turns         ${String(diff.a.turnCount).padEnd(12)} ${String(diff.b.turnCount).padEnd(12)} ${sign(diff.turnsDelta)}`)
  console.log(`models        ${diff.a.models.join(',').padEnd(12)} ${diff.b.models.join(',').padEnd(12)}`)
  if (diff.toolsAdded.length > 0) console.log(`tools added:   ${colors.green(diff.toolsAdded.join(', '))}`)
  if (diff.toolsRemoved.length > 0) console.log(`tools removed: ${colors.red(diff.toolsRemoved.join(', '))}`)
}

// ── teya trace assert <id> [--max-cost X] [--max-tokens N] [--max-turns N] ───
//    Returns non-zero exit code on violation. For CI / regression testing.
function cmdAssert(args: string[]): void {
  const wanted = args.find(a => !a.startsWith('--'))
  if (!wanted) {
    console.error(colors.red('Usage: teya trace assert <session-id> [--max-cost USD] [--max-tokens N] [--max-turns N] [--no-fallback] [--no-errors]'))
    process.exit(2)
  }
  const all = listTracedSessions(SESSIONS_DIR)
  const session = all.find(s => s.sessionId.startsWith(wanted))
  if (!session) {
    console.error(colors.red(`No session found matching "${wanted}"`))
    process.exit(2)
  }

  const maxCost = parseFloat(args.find((a, i) => args[i - 1] === '--max-cost') || 'NaN')
  const maxTokens = parseInt(args.find((a, i) => args[i - 1] === '--max-tokens') || 'NaN', 10)
  const maxTurns = parseInt(args.find((a, i) => args[i - 1] === '--max-turns') || 'NaN', 10)
  const noFallback = args.includes('--no-fallback')
  const noErrors = args.includes('--no-errors')

  const cost = session.actualCostUsd > 0 ? session.actualCostUsd : session.estimatedCostUsd
  const violations: string[] = []

  if (Number.isFinite(maxCost) && cost > maxCost) {
    violations.push(`cost ${fmtUsd(cost)} > max ${fmtUsd(maxCost)}`)
  }
  if (Number.isFinite(maxTokens) && session.totalInputTokens > maxTokens) {
    violations.push(`input tokens ${session.totalInputTokens} > max ${maxTokens}`)
  }
  if (Number.isFinite(maxTurns) && session.turnCount > maxTurns) {
    violations.push(`turns ${session.turnCount} > max ${maxTurns}`)
  }
  if (noErrors && session.errorCount > 0) {
    violations.push(`errors ${session.errorCount} > 0`)
  }
  if (noFallback) {
    const spans = loadSessionSpans(SESSIONS_DIR, session.sessionId)
    if (spans.some(s => s.name === 'provider.fallback')) {
      violations.push(`provider fallback fired`)
    }
  }

  if (violations.length > 0) {
    console.error(colors.red(`✗ ${session.sessionId.slice(0, 8)} FAILED ${violations.length} assertion(s):`))
    for (const v of violations) console.error(colors.red(`  - ${v}`))
    process.exit(1)
  }
  console.log(colors.green(`✓ ${session.sessionId.slice(0, 8)} passed all assertions`))
}

// ── teya trace backfill <session-id> — fetch missing actual costs ────────────
async function cmdBackfill(args: string[]): Promise<void> {
  const wanted = args[0]
  if (!wanted) {
    console.error(colors.red('Usage: teya trace backfill <session-id-prefix>'))
    process.exit(1)
  }

  const all = listTracedSessions(SESSIONS_DIR)
  const session = all.find(s => s.sessionId.startsWith(wanted))
  if (!session) {
    console.error(colors.red(`No session found matching "${wanted}"`))
    process.exit(1)
  }

  // Lazy-load providers + tracing to keep the rest of the trace CLI light.
  const { openrouter } = await import('@teya/providers')
  const { sessionFileExporter, AgentTracer } = await import('@teya/tracing')

  // Inline mini config reader — avoids importing the main CLI module.
  const configFile = join(CONFIG_DIR, 'config.json')
  const saved: Record<string, string> = existsSync(configFile)
    ? (() => { try { return JSON.parse(readFileSync(configFile, 'utf-8')) } catch { return {} } })()
    : {}
  const apiKey = saved.apiKey || process.env.OPENROUTER_API_KEY || ''
  if (!apiKey) {
    console.error(colors.red('No OpenRouter API key — set OPENROUTER_API_KEY or save in ~/.teya/config.json'))
    process.exit(1)
  }
  const provider = openrouter({ model: saved.model || 'qwen/qwen3.6-plus', apiKey })
  if (!provider.getGenerationDetails) {
    console.error(colors.red('Provider does not support generation details lookup'))
    process.exit(1)
  }

  const spans = loadSessionSpans(SESSIONS_DIR, session.sessionId)
  // Find llm.generate spans that have a generation id but no matching
  // llm.generation_details sibling.
  const haveActualForId = new Set(
    spans
      .filter(s => s.name === 'llm.generation_details')
      .map(s => s.attributes['gen_ai.response.id'] as string)
  )
  const targets = spans
    .filter(s => s.name === 'llm.generate')
    .map(s => s.attributes['gen_ai.response.id'] as string | undefined)
    .filter((id): id is string => !!id && !haveActualForId.has(id))

  if (targets.length === 0) {
    console.log(colors.dim('Nothing to backfill — all generations already enriched.'))
    return
  }
  console.log(`Backfilling ${targets.length} generation id(s) for ${session.sessionId.slice(0, 8)}...`)

  const exporter = sessionFileExporter(SESSIONS_DIR)
  const tracer = new AgentTracer(exporter, { capabilities: provider.capabilities })
  tracer.setContext({ sessionId: session.sessionId, agentId: session.agentId, transport: session.transport })

  let ok = 0
  for (const id of targets) {
    const details = await provider.getGenerationDetails!(id)
    if (details && details.actualCostUsd !== undefined) {
      tracer.processEvent({
        type: 'generation_details',
        generationId: id,
        actualCostUsd: details.actualCostUsd,
        cachedInputTokens: details.cachedInputTokens,
        latencyMs: details.latencyMs,
        providerName: details.providerName,
      })
      console.log(colors.green(`  ✓ ${id.slice(0, 30)}  ${fmtUsd(details.actualCostUsd)}`))
      ok++
    } else {
      console.log(colors.dim(`  · ${id.slice(0, 30)}  not yet available`))
    }
  }
  console.log(`\nBackfilled ${ok}/${targets.length}.`)
}

// ── Entry point ──────────────────────────────────────────────────────────────
export async function handleTraceCommand(argv: string[]): Promise<void> {
  const action = argv[0] || 'list'
  const rest = argv.slice(1)
  switch (action) {
    case 'list':
    case 'ls':
      cmdList(rest)
      return
    case 'show':
      cmdShow(rest)
      return
    case 'cost':
      cmdCost(rest)
      return
    case 'tail':
      await cmdTail()
      return
    case 'backfill':
      await cmdBackfill(rest)
      return
    case 'anomalies':
    case 'outliers':
      cmdAnomalies(rest)
      return
    case 'diff':
      cmdDiff(rest)
      return
    case 'assert':
      cmdAssert(rest)
      return
    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(`teya trace — view and analyze agent traces

Commands:
  list [--limit N]                  List traced sessions, newest first
  show <session-id> [--json]        Full span tree for one session
  cost [--by-model|--by-tool|--by-session]
                                    Aggregate cost across all sessions
  tail                              Live-follow today's trace with running totals
  backfill <session-id>             Fetch missing actual costs from provider
  anomalies [--sigma=N]             List sessions with outlier cost/tokens (default 2σ)
  diff <session-a> <session-b>      Side-by-side comparison of two sessions
  assert <session-id> <flags>       Pass/fail assertions for CI:
                                      --max-cost USD  --max-tokens N  --max-turns N
                                      --no-errors     --no-fallback

Traces live in: ${CONFIG_DIR}/traces/
  sessions/<id>.jsonl              per-session spans (used by show/cost)
  YYYY-MM-DD.jsonl                 daily aggregate (used by tail)`)
  }
}
