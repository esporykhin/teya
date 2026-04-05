/**
 * @description Run eval suite against agent — collect events, check side effects.
 */
import { agentLoop } from '@teya/core'
import type { LLMProvider, AgentEvent } from '@teya/core'
import { execSync } from 'child_process'
import type { EvalSuite, EvalResult, EvalContext } from './types.js'
import { scoreResult } from './scorer.js'

interface ToolRegistry {
  get(name: string): unknown
  list(): unknown[]
  listNames(): string[]
  execute(call: { id: string; name: string; args: Record<string, unknown> }): Promise<{ callId: string; result: string; error?: boolean }>
}

export interface RunnerDeps {
  provider: LLMProvider
  toolRegistry: ToolRegistry
  systemPrompt: string
  workspaceRoot?: string
}

export async function runEvalSuite(suite: EvalSuite, deps: RunnerDeps): Promise<EvalResult[]> {
  const results: EvalResult[] = []
  const workspaceRoot = deps.workspaceRoot || process.cwd()

  // Setup
  if (suite.setup) {
    for (const cmd of suite.setup) {
      try {
        execSync(cmd, { cwd: workspaceRoot, stdio: 'pipe', timeout: 30000 })
      } catch (err) {
        console.error(`Setup failed: ${cmd} — ${(err as Error).message}`)
      }
    }
  }

  for (let i = 0; i < suite.cases.length; i++) {
    const evalCase = suite.cases[i]
    const caseName = evalCase.name || `Case ${i + 1}`
    process.stderr.write(`  Running: ${caseName}...`)

    const startTime = Date.now()
    let response = ''
    const toolsCalled: string[] = []
    const toolArgs: Array<{ tool: string; args: Record<string, unknown> }> = []
    let turns = 0
    let cost = 0
    let error: string | undefined

    try {
      const events = agentLoop(
        {
          provider: deps.provider,
          toolRegistry: deps.toolRegistry as any,
          systemPrompt: deps.systemPrompt,
          config: {
            maxTurns: evalCase.expected.max_turns ?? 20,
            maxCostPerSession: evalCase.expected.max_cost ?? 1,
          },
        },
        evalCase.input,
        [],
      )

      for await (const event of events) {
        if (event.type === 'response') response = event.content
        if (event.type === 'tool_start') {
          toolsCalled.push(event.tool)
          toolArgs.push({ tool: event.tool, args: event.args })
        }
        if (event.type === 'thinking_end') {
          turns++
          // Accumulate cost from token usage
          const cap = deps.provider.capabilities
          cost += event.tokens.inputTokens * cap.costPerInputToken
            + event.tokens.outputTokens * cap.costPerOutputToken
        }
        if (event.type === 'error') error = event.error
      }
    } catch (err) {
      error = (err as Error).message
    }

    const duration = Date.now() - startTime
    const ctx: EvalContext = { response, toolsCalled, toolArgs, cost, turns, duration, workspaceRoot }
    const checks = await scoreResult(evalCase, ctx)
    const passed = checks.every(c => c.passed) && !error

    process.stderr.write(` ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} (${duration}ms)\n`)

    results.push({
      caseName,
      input: evalCase.input,
      passed,
      checks,
      response,
      toolsCalled,
      cost,
      turns,
      duration,
      error,
    })
  }

  // Teardown
  if (suite.teardown) {
    for (const cmd of suite.teardown) {
      try {
        execSync(cmd, { cwd: workspaceRoot, stdio: 'pipe', timeout: 30000 })
      } catch {}
    }
  }

  return results
}

export function formatResults(results: EvalResult[]): string {
  const lines: string[] = []
  const passed = results.filter(r => r.passed).length
  const total = results.length

  lines.push(`\nResults: ${passed}/${total} passed\n`)

  for (const result of results) {
    const icon = result.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
    lines.push(`  ${icon} ${result.caseName} (${result.duration}ms, ${result.turns} turns, $${result.cost.toFixed(4)})`)

    if (!result.passed) {
      for (const check of result.checks.filter(c => !c.passed)) {
        lines.push(`    \x1b[31m- ${check.check}: ${check.detail || 'failed'}\x1b[0m`)
      }
      if (result.error) {
        lines.push(`    \x1b[31m- Error: ${result.error}\x1b[0m`)
      }
    }
  }

  const totalCost = results.reduce((sum, r) => sum + r.cost, 0)
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0)
  lines.push(`\nTotal: $${totalCost.toFixed(4)}, ${(totalDuration / 1000).toFixed(1)}s`)

  return lines.join('\n')
}
