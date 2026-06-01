/**
 * @description Thin executor for "claude-agent" Telegram bots. Each such bot is
 *  a PURE transport to a Claude Code agent (`claude --agent <name>`): all brains,
 *  tools and memory live on the Claude Code side, teya stores nothing. This file
 *  owns (1) the per-(bot,chat) continuous claude session map — first turn uses
 *  `--session-id <uuid>`, every later turn uses `--resume <id>` — and (2) the
 *  arg builder + subprocess runner. Logic mirrors the reference Python gateway
 *  (command-center/comms/tg_gateway/core.py :: call_agent), reimplemented in TS.
 *
 *  Why a separate runner instead of the teya agentLoop: claude-agent bots must
 *  NOT touch teya's KnowledgeGraph / sessions.db / agentLoop. They are a black
 *  box — text in, text out — so the multiplexer handles them inline and never
 *  emits to the host messageHandler for these bots.
 *
 * @exports buildClaudeAgentArgs, runClaudeAgent, ClaudeSessionStore, ClaudeAgentRunner
 */
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'

/** Canonical UUID (any version). claude's --session-id / --resume take a uuid. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ClaudeAgentArgsInput {
  /** Claude Code agent name (file under ~/.claude/agents/<name>.md). */
  agent: string
  /** Continuous-session uuid for this (bot,chat). */
  sessionId: string
  /** True on the very first turn → `--session-id`, else `--resume`. */
  isNew: boolean
  /** Optional model override (e.g. "opus", "sonnet", "claude-opus-4-6"). */
  model?: string
  /**
   * Grant the agent read access to the WHOLE filesystem (`--add-dir /`). OFF by
   * default — a stranger who slips past the auth gate then only reaches `cwd`,
   * not `/`. Opt-in per bot (owner agents that genuinely need it). When false we
   * still scope the agent to its `cwd` via `--add-dir <cwd>`.
   */
  addRootDir?: boolean
  /** Working directory — used as the scoped `--add-dir` when addRootDir is off. */
  cwd?: string
  /** Additional directories to grant read access via `--add-dir` (e.g. temp media dirs). */
  extraDirs?: string[]
  /**
   * Reasoning effort → `claude --effort <level>`. The claude CLI supports
   * low/medium/high (also xhigh/max, which we don't expose). Omitted ⇒ claude's
   * own default. We pass low/high explicitly; "medium" is the CLI default so we
   * STILL pass it (harmless, keeps behaviour explicit and survives a default
   * change upstream).
   */
  effort?: 'low' | 'medium' | 'high'
}

/**
 * Build the argv for `claude` in agent mode. Mirrors the Python gateway:
 *   claude --print <session-args> --agent <name> --output-format json
 *          --dangerously-skip-permissions [--add-dir /] [--model M]
 *
 * Crucially: in agent mode we DO NOT pass `--append-system-prompt`. The agent's
 * own persona (~/.claude/agents/<name>.md) is the system prompt; layering teya's
 * prompt on top would corrupt it. The teya `claudeCode` provider asserts the
 * same invariant for its own agent path.
 */
export function buildClaudeAgentArgs(input: ClaudeAgentArgsInput): string[] {
  if (!input.agent) throw new Error('buildClaudeAgentArgs: agent name is required')
  if (!input.sessionId) throw new Error('buildClaudeAgentArgs: sessionId is required')
  // sessionId is interpolated straight into the claude argv (--session-id/--resume).
  // It must be a UUID we generated — never anything user-influenced — or it becomes
  // an argument-injection vector. Reject everything that isn't a canonical uuid.
  if (!UUID_RE.test(input.sessionId)) {
    throw new Error(`buildClaudeAgentArgs: sessionId must be a UUID, got ${JSON.stringify(input.sessionId)}`)
  }
  const sessionArgs = input.isNew
    ? ['--session-id', input.sessionId]
    : ['--resume', input.sessionId]
  const args = [
    '--print',
    ...sessionArgs,
    '--agent', input.agent,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ]
  // Safe default: scope reads to cwd. Only `addRootDir: true` opens the whole FS.
  if (input.addRootDir === true) args.push('--add-dir', '/')
  else if (input.cwd) args.push('--add-dir', input.cwd)
  if (input.extraDirs) {
    for (const d of input.extraDirs) args.push('--add-dir', d)
  }
  if (input.model) args.push('--model', input.model)
  // Reasoning effort. `claude --effort <low|medium|high|...>` is a native flag
  // (`claude --help`: "--effort <level>  Effort level for the current session
  // (low, medium, high, xhigh, max)"), so this is a direct 1:1 mapping.
  if (input.effort) args.push('--effort', input.effort)
  return args
}

interface ClaudeJsonResult {
  type?: string
  subtype?: string
  result?: string
  session_id?: string
  is_error?: boolean
  error?: string
}

/**
 * Per-(bot,chat) continuous claude session ids. Kept in memory only — the
 * multiplexer is a long-lived process, and a fresh uuid on restart simply starts
 * a new claude conversation (claude itself persists transcripts on disk under
 * the session id, so a manual --resume is still possible out of band).
 */
export class ClaudeSessionStore {
  private map = new Map<string, string>()

  /** Return (sessionId, isNew). isNew=true ⇒ caller uses --session-id. */
  getOrCreate(chatKey: string): { sessionId: string; isNew: boolean } {
    const existing = this.map.get(chatKey)
    if (existing) return { sessionId: existing, isNew: false }
    const sessionId = randomUUID()
    this.map.set(chatKey, sessionId)
    return { sessionId, isNew: true }
  }

  /** Forget the session for a chat (e.g. on /clear) — next turn starts fresh. */
  reset(chatKey: string): void {
    this.map.delete(chatKey)
  }

  has(chatKey: string): boolean {
    return this.map.has(chatKey)
  }
}

/** Spawn claude, feed `prompt` on stdin, collect stdout/stderr. */
function spawnClaude(
  binary: string,
  args: string[],
  prompt: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    // Drop CLAUDECODE so a claude-inside-claude invocation doesn't get confused
    // (the reference gateway does the same). Everything else inherits.
    const env = { ...process.env }
    delete env.CLAUDECODE

    const proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd, env })
    let stdout = ''
    let stderr = ''
    let settled = false
    let killTimer: NodeJS.Timeout | null = null

    // Detach from the streams and arm a SIGKILL backstop after a SIGTERM: a
    // claude that ignores SIGTERM must not linger forever holding the cwd.
    const terminate = () => {
      proc.kill('SIGTERM')
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch {}
      }, 5000)
      // unref so the kill timer alone never keeps the event loop alive
      killTimer.unref?.()
    }
    const teardown = () => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      try { proc.stdout?.destroy() } catch {}
      try { proc.stderr?.destroy() } catch {}
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      terminate()
      reject(new Error(`claude --agent timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('error', (err: Error) => {
      if (settled) return
      settled = true
      teardown()
      reject(new Error(`claude spawn error: ${err.message}`))
    })

    proc.on('close', (code: number | null) => {
      if (settled) {
        // Already settled (timeout/abort) — process finally exited; reap timers/streams.
        teardown()
        return
      }
      settled = true
      teardown()
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })

    if (signal) {
      const onAbort = () => {
        if (settled) return
        settled = true
        terminate()
        reject(new Error('claude --agent aborted'))
      }
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
      proc.on('close', () => signal.removeEventListener('abort', onAbort))
    }

    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

export interface RunClaudeAgentOptions {
  binary?: string
  cwd: string
  timeoutMs?: number
  addRootDir?: boolean
  /** Additional directories to grant read access via `--add-dir`. */
  extraDirs?: string[]
  /** Reasoning effort → `claude --effort`. Omitted ⇒ claude default. */
  effort?: 'low' | 'medium' | 'high'
  signal?: AbortSignal
}

/**
 * Run one turn of a claude agent with a continuous per-chat session.
 * Resolves the (sessionId, isNew) from `store`, builds args, spawns claude,
 * parses the JSON envelope, returns the assistant's final text. Throws on
 * empty output or an is_error envelope (mirrors the Python gateway).
 */
export async function runClaudeAgent(
  store: ClaudeSessionStore,
  chatKey: string,
  prompt: string,
  agent: string,
  opts: RunClaudeAgentOptions,
  model?: string,
): Promise<string> {
  const { sessionId, isNew } = store.getOrCreate(chatKey)
  const args = buildClaudeAgentArgs({
    agent,
    sessionId,
    isNew,
    model,
    addRootDir: opts.addRootDir,
    extraDirs: opts.extraDirs,
    cwd: opts.cwd,
    effort: opts.effort,
  })
  const binary = opts.binary ?? 'claude'
  const timeoutMs = opts.timeoutMs ?? 120_000

  // If anything below throws/returns an error, the underlying claude session may
  // be in a bad state (or never started). Drop it so the NEXT turn opens a fresh
  // `--session-id` instead of `--resume`-ing a broken/half-written transcript.
  const dropSession = () => store.reset(chatKey)

  let result: { stdout: string; stderr: string; exitCode: number }
  try {
    result = await spawnClaude(binary, args, prompt, opts.cwd, timeoutMs, opts.signal)
  } catch (err) {
    dropSession()
    throw err
  }
  const { stdout, stderr, exitCode } = result

  const raw = stdout.trim()
  if (!raw) {
    dropSession()
    // Do NOT echo raw claude stderr (may carry tokens/paths) into the thrown
    // message that lands in the shared log — keep a short, scrubbed tail only.
    throw new Error(
      `claude --agent ${agent} returned empty output (exit ${exitCode}). stderr (truncated): ${stderr.trim().slice(0, 200)}`,
    )
  }

  let data: ClaudeJsonResult | undefined
  try {
    data = JSON.parse(raw) as ClaudeJsonResult
  } catch {
    // Not JSON — still a usable reply (claude printed plain text).
    return raw
  }
  if (data.is_error) {
    dropSession()
    throw new Error(`claude --agent ${agent} reported an error: ${(data.result || data.error || '').slice(0, 400)}`)
  }
  return (data.result ?? '').trim()
}

/**
 * Stateful wrapper binding one claude-agent bot's identity (agent name, cwd,
 * model, binary) to a session store. The multiplexer holds one instance per
 * claude-agent bot and calls `run(chatKey, prompt, signal)` per message.
 */
export class ClaudeAgentRunner {
  private store = new ClaudeSessionStore()
  /**
   * Per-chatKey serialization tail. A claude session is single-threaded: two
   * concurrent `claude --resume <same id>` turns would race on (and corrupt) the
   * shared transcript. So each chatKey gets a promise chain — a new turn awaits
   * the previous turn for that chat before it spawns. Different chats stay
   * fully parallel.
   */
  private inflight = new Map<string, Promise<unknown>>()

  constructor(private readonly cfg: {
    agent: string
    cwd: string
    model?: string
    binary?: string
    timeoutMs?: number
    addRootDir?: boolean
    extraDirs?: string[]
    /** Reasoning effort → `claude --effort`. Omitted ⇒ claude default. */
    effort?: 'low' | 'medium' | 'high'
  }) {
    if (!cfg.agent) throw new Error('ClaudeAgentRunner: agent name is required')
    if (!cfg.cwd) throw new Error('ClaudeAgentRunner: cwd is required')
  }

  run(chatKey: string, prompt: string, signal?: AbortSignal): Promise<string> {
    const prev = this.inflight.get(chatKey) ?? Promise.resolve()
    // Chain after the previous turn (ignoring its outcome), then run ours.
    const next = prev.catch(() => {}).then(() => this.runTurn(chatKey, prompt, signal))
    // Track the chain so the FOLLOWING turn waits on it; clean the map entry
    // once we're the tail, to avoid unbounded growth across many one-off chats.
    const tracked = next.finally(() => {
      if (this.inflight.get(chatKey) === tracked) this.inflight.delete(chatKey)
    })
    this.inflight.set(chatKey, tracked)
    // `tracked` exists ONLY to serialize the FOLLOWING turn (which consumes its
    // outcome via `prev.catch(() => {})`). When no following turn arrives, a
    // rejected `tracked` floats as an unhandled rejection and crashes the whole
    // multiplexer — KeepAlive then restarts it, it re-pulls the same message and
    // loops forever. The real result/rejection still reaches the caller via
    // `next`; here we just mark the bookkeeping promise as handled.
    void tracked.catch(() => {})
    return next
  }

  private runTurn(chatKey: string, prompt: string, signal?: AbortSignal): Promise<string> {
    return runClaudeAgent(
      this.store,
      chatKey,
      prompt,
      this.cfg.agent,
      {
        binary: this.cfg.binary,
        cwd: this.cfg.cwd,
        timeoutMs: this.cfg.timeoutMs,
        addRootDir: this.cfg.addRootDir,
        extraDirs: this.cfg.extraDirs,
        effort: this.cfg.effort,
        signal,
      },
      this.cfg.model,
    )
  }

  reset(chatKey: string): void {
    this.store.reset(chatKey)
  }
}
