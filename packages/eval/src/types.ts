/**
 * @description Eval types — EvalSuite, EvalCase, EvalResult, CheckResult
 *
 * Supports three layers of checks:
 * 1. Response checks — what the agent said (response_contains, response_matches)
 * 2. Behavior checks — what tools were called, cost, turns
 * 3. Side effect checks — what actually happened (file created, DB record, etc.)
 */

export interface EvalSuite {
  name: string
  description?: string
  /** Setup commands to run before the suite (e.g., clean workspace) */
  setup?: string[]
  /** Teardown commands to run after the suite */
  teardown?: string[]
  cases: EvalCase[]
}

export interface EvalCase {
  name?: string
  /** The user message to send to the agent */
  input: string
  /** Optional context/history to prepend */
  context?: string
  /** Optional: specific agent to test (sub-agent ID) */
  agent?: string

  expected: {
    // ── Response checks ──────────────────────────────────────────────
    response_contains?: string | string[]
    response_not_contains?: string | string[]

    // ── Behavior checks ──────────────────────────────────────────────
    tool_called?: string | string[]
    no_tool_called?: string | string[]
    tool_call_count?: { tool: string; min?: number; max?: number }
    max_cost?: number
    max_turns?: number

    // ── Side effect checks ───────────────────────────────────────────
    /** Check that a file exists after execution */
    file_exists?: string | string[]
    /** Check that a file contains specific text */
    file_contains?: { path: string; contains: string }[]
    /** Check file size bounds */
    file_size?: { path: string; min?: number; max?: number }
    /** Check that a task was created in TaskStore */
    task_created?: { title_contains?: string; has_cron?: boolean; has_prompt?: boolean; assignee?: string }
    /** Check that a memory entity exists */
    entity_exists?: { name: string; type?: string }
    /** Check that a fact was saved */
    fact_contains?: { entity: string; content_contains: string }
    /** Run a shell command and check exit code + output */
    exec_check?: { command: string; exit_code?: number; output_contains?: string }
    /** Custom assertion function (for programmatic evals) */
    custom?: (context: EvalContext) => boolean | Promise<boolean>
  }
}

/** Context passed to custom assertions and side effect checks */
export interface EvalContext {
  response: string
  toolsCalled: string[]
  toolArgs: Array<{ tool: string; args: Record<string, unknown> }>
  cost: number
  turns: number
  duration: number
  workspaceRoot: string
}

export interface EvalResult {
  caseName: string
  input: string
  passed: boolean
  checks: CheckResult[]
  response?: string
  toolsCalled: string[]
  cost: number
  turns: number
  duration: number
  error?: string
}

export interface CheckResult {
  check: string
  passed: boolean
  detail?: string
}
