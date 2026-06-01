/**
 * @description `teya pac run` — run a BitGN benchmark with Teya's agent loop.
 *
 * Usage:
 *   teya pac run [--benchmark=<id>] [--task=<id> ...] [--provider=ollama|openrouter]
 *                [--model=<name>] [--api-key=<k>] [--host=<url>] [--max-turns=N]
 *
 * Defaults:
 *   --benchmark bitgn/sandbox
 *   --provider  ollama
 *   --model     qwen3.5:9b  (for ollama) or z-ai/glm-4.7 (for openrouter)
 *
 * Sandbox mode does not require an API key. Leaderboard runs need --api-key and
 * are triggered when the benchmark id does not start with "bitgn/sandbox".
 */
import { ollama, openrouter, withToolAdapter } from '@teya/providers'
import type { LLMProvider } from '@teya/core'
import { runBenchmark, type RunnerOptions } from './runner.js'

interface Args {
  benchmark: string
  tasks: string[]
  provider: 'ollama' | 'openrouter'
  model?: string
  apiKey?: string
  host?: string
  maxTurns?: number
  toolAdapter: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    benchmark: 'bitgn/sandbox',
    tasks: [],
    provider: 'ollama',
    toolAdapter: false,
  }
  for (const raw of argv) {
    const eq = raw.indexOf('=')
    const key = eq >= 0 ? raw.slice(0, eq) : raw
    const val = eq >= 0 ? raw.slice(eq + 1) : ''
    switch (key) {
      case '--benchmark': out.benchmark = val; break
      case '--task': out.tasks.push(val); break
      case '--provider':
        if (val !== 'ollama' && val !== 'openrouter') throw new Error(`Unknown provider: ${val}`)
        out.provider = val
        break
      case '--model': out.model = val; break
      case '--api-key': out.apiKey = val; break
      case '--host': out.host = val; break
      case '--max-turns': out.maxTurns = Number(val); break
      case '--tool-adapter': out.toolAdapter = true; break
      default:
        if (raw.startsWith('--')) throw new Error(`Unknown flag: ${key}`)
    }
  }
  return out
}

function buildProvider(args: Args): LLMProvider {
  if (args.provider === 'ollama') {
    const model = args.model ?? 'qwen3.5:9b'
    const base = ollama({ model, toolCalling: true })
    return args.toolAdapter ? withToolAdapter(base) : base
  }
  const model = args.model ?? 'z-ai/glm-4.7'
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set (required for --provider=openrouter)')
  // Reasoning models (deepseek-v3.2, o1, etc) burn minutes on invisible thinking
  // which is useless for a 30+ step agent loop. Turn it off by default for PAC.
  const isReasoningModel = /v3\.2|\bo1\b|\bo3\b|reasoning|thinking/i.test(model)
  return openrouter({ apiKey, model, disableReasoning: isReasoningModel })
}

export async function pacCli(argv: string[]): Promise<number> {
  const sub = argv[0]
  if (sub !== 'run') {
    console.error('usage: teya pac run [flags]')
    return 1
  }
  const args = parseArgs(argv.slice(1))
  const provider = buildProvider(args)

  const opts: RunnerOptions = {
    benchmarkId: args.benchmark,
    provider,
    apiKey: args.apiKey,
    taskFilter: args.tasks,
    host: args.host,
    maxTurns: args.maxTurns,
    onEvent: (trialId, event) => {
      if (event.type === 'tool_start') {
        console.log(`  [${trialId}] -> ${event.tool}(${Object.keys(event.args).join(',')})`)
      } else if (event.type === 'tool_result') {
        const preview = event.result.slice(0, 120).replace(/\n/g, ' ')
        console.log(`  [${trialId}] <- ${event.tool}: ${preview}`)
      } else if (event.type === 'tool_error') {
        console.log(`  [${trialId}] !! ${event.tool}: ${event.error}`)
      } else if (event.type === 'thinking_end') {
        const t = event.tokens
        console.log(`  [${trialId}] llm in=${t.inputTokens ?? '?'} out=${t.outputTokens ?? '?'}`)
      }
    },
  }

  const summary = await runBenchmark(opts)

  console.log('')
  console.log(`\x1b[1m=== ${summary.benchmarkId} (${summary.mode}) ===\x1b[0m`)
  for (const t of summary.trials) {
    const score = t.error ? 'ERR' : `${(t.score * 100).toFixed(0)}%`
    const color = t.error || t.score === 0 ? '\x1b[31m' : t.score >= 0.8 ? '\x1b[32m' : '\x1b[33m'
    console.log('')
    console.log(`${color}[${t.taskId || t.trialId}] ${score}\x1b[0m`)
    console.log(`  task:   ${t.instruction.replace(/\n/g, ' ').slice(0, 240)}`)
    if (t.answer) {
      console.log(`  answer: ${t.answer.replace(/\n/g, ' ').slice(0, 240)}`)
    }
    if (t.refs && t.refs.length) {
      console.log(`  refs:   ${t.refs.join(', ')}`)
    }
    if (t.scoreDetail && t.scoreDetail.length) {
      for (const line of t.scoreDetail) {
        console.log(`  score:  ${line}`)
      }
    }
    if (t.error) {
      console.log(`  error:  ${t.error}`)
    }
  }
  console.log('')
  console.log(`\x1b[1mFINAL: ${(summary.average * 100).toFixed(2)}%\x1b[0m`)
  return 0
}
