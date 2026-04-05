/**
 * @description Deterministic scorers — response, behavior, and side effect checks.
 */
import { readFile, stat } from 'fs/promises'
import { execSync } from 'child_process'
import type { EvalCase, CheckResult, EvalContext } from './types.js'

export async function scoreResult(evalCase: EvalCase, ctx: EvalContext): Promise<CheckResult[]> {
  const checks: CheckResult[] = []
  const expected = evalCase.expected

  // ── Response checks ──────────────────────────────────────────────────

  if (expected.response_contains) {
    const terms = Array.isArray(expected.response_contains) ? expected.response_contains : [expected.response_contains]
    for (const term of terms) {
      const passed = ctx.response.toLowerCase().includes(term.toLowerCase())
      checks.push({ check: `response_contains: "${term}"`, passed, detail: passed ? undefined : 'Not found in response' })
    }
  }

  if (expected.response_not_contains) {
    const terms = Array.isArray(expected.response_not_contains) ? expected.response_not_contains : [expected.response_not_contains]
    for (const term of terms) {
      const found = ctx.response.toLowerCase().includes(term.toLowerCase())
      checks.push({ check: `response_not_contains: "${term}"`, passed: !found, detail: found ? 'Found in response (should not be)' : undefined })
    }
  }

  // ── Behavior checks ──────────────────────────────────────────────────

  if (expected.tool_called) {
    const tools = Array.isArray(expected.tool_called) ? expected.tool_called : [expected.tool_called]
    for (const tool of tools) {
      const passed = ctx.toolsCalled.some(t => t.includes(tool))
      checks.push({ check: `tool_called: ${tool}`, passed, detail: passed ? undefined : `Called: ${ctx.toolsCalled.join(', ') || 'none'}` })
    }
  }

  if (expected.no_tool_called) {
    const tools = Array.isArray(expected.no_tool_called) ? expected.no_tool_called : [expected.no_tool_called]
    for (const tool of tools) {
      const called = ctx.toolsCalled.some(t => t.includes(tool))
      checks.push({ check: `no_tool_called: ${tool}`, passed: !called, detail: called ? `Tool ${tool} was called` : undefined })
    }
  }

  if (expected.tool_call_count) {
    const { tool, min, max } = expected.tool_call_count
    const count = ctx.toolsCalled.filter(t => t.includes(tool)).length
    const passed = (min === undefined || count >= min) && (max === undefined || count <= max)
    checks.push({ check: `tool_call_count: ${tool} [${min ?? 0}-${max ?? 'inf'}]`, passed, detail: passed ? undefined : `Count: ${count}` })
  }

  if (expected.max_cost !== undefined) {
    const passed = ctx.cost <= expected.max_cost
    checks.push({ check: `max_cost: $${expected.max_cost}`, passed, detail: passed ? undefined : `Actual: $${ctx.cost.toFixed(4)}` })
  }

  if (expected.max_turns !== undefined) {
    const passed = ctx.turns <= expected.max_turns
    checks.push({ check: `max_turns: ${expected.max_turns}`, passed, detail: passed ? undefined : `Actual: ${ctx.turns}` })
  }

  // ── Side effect checks ───────────────────────────────────────────────

  if (expected.file_exists) {
    const paths = Array.isArray(expected.file_exists) ? expected.file_exists : [expected.file_exists]
    for (const path of paths) {
      const resolved = resolvePath(path, ctx.workspaceRoot)
      try {
        await stat(resolved)
        checks.push({ check: `file_exists: ${path}`, passed: true })
      } catch {
        checks.push({ check: `file_exists: ${path}`, passed: false, detail: `File not found: ${resolved}` })
      }
    }
  }

  if (expected.file_contains) {
    for (const fc of expected.file_contains) {
      const resolved = resolvePath(fc.path, ctx.workspaceRoot)
      try {
        const content = await readFile(resolved, 'utf-8')
        const passed = content.includes(fc.contains)
        checks.push({
          check: `file_contains: ${fc.path} has "${fc.contains.slice(0, 50)}"`,
          passed,
          detail: passed ? undefined : `File exists (${content.length} chars) but doesn't contain expected text`,
        })
      } catch {
        checks.push({ check: `file_contains: ${fc.path}`, passed: false, detail: `File not found: ${resolved}` })
      }
    }
  }

  if (expected.file_size) {
    const { path, min, max } = expected.file_size
    const resolved = resolvePath(path, ctx.workspaceRoot)
    try {
      const s = await stat(resolved)
      const passed = (min === undefined || s.size >= min) && (max === undefined || s.size <= max)
      checks.push({ check: `file_size: ${path} [${min ?? 0}-${max ?? 'inf'}]`, passed, detail: passed ? undefined : `Actual: ${s.size} bytes` })
    } catch {
      checks.push({ check: `file_size: ${path}`, passed: false, detail: 'File not found' })
    }
  }

  if (expected.exec_check) {
    const { command, exit_code, output_contains } = expected.exec_check
    try {
      const output = execSync(command, { encoding: 'utf-8', timeout: 10000, cwd: ctx.workspaceRoot }).trim()
      if (exit_code !== undefined && exit_code !== 0) {
        checks.push({ check: `exec_check: ${command}`, passed: false, detail: `Expected exit ${exit_code}, got 0` })
      } else {
        if (output_contains) {
          const passed = output.includes(output_contains)
          checks.push({ check: `exec_check: contains "${output_contains.slice(0, 50)}"`, passed, detail: passed ? undefined : `Output: ${output.slice(0, 200)}` })
        } else {
          checks.push({ check: `exec_check: ${command}`, passed: true })
        }
      }
    } catch (err: any) {
      const code = err.status ?? -1
      if (exit_code !== undefined && exit_code === code) {
        checks.push({ check: `exec_check: exit ${exit_code}`, passed: true })
      } else {
        checks.push({ check: `exec_check: ${command}`, passed: false, detail: `Exit code: ${code}` })
      }
    }
  }

  // Custom assertion
  if (expected.custom) {
    try {
      const passed = await expected.custom(ctx)
      checks.push({ check: 'custom assertion', passed })
    } catch (err) {
      checks.push({ check: 'custom assertion', passed: false, detail: (err as Error).message })
    }
  }

  return checks
}

function resolvePath(path: string, workspaceRoot: string): string {
  if (path.startsWith('/')) return path
  return `${workspaceRoot}/${path}`
}
