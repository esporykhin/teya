/**
 * @description Single source of truth for long-running teya processes.
 *
 * This package owns BOTH:
 *  - Process tracking (PID, args, log file) — for restart-on-update flows
 *  - Liveness signal (heartbeat) — for "is the daemon healthy" checks
 *
 * Storage:
 *   ~/.teya/run/<id>.json
 *   {
 *     id, pid, startedAt, args, description, logFile, lastHeartbeat
 *   }
 *
 * Architectural rules:
 *  - This package depends ONLY on node:fs / node:os / node:child_process.
 *    No workspace deps. Both @teya/cli and @teya/scheduler can import it
 *    without creating cycles.
 *  - Each long-running process registers ITSELF on startup (no proxy
 *    registration from a sibling package). The daemon import this module
 *    and call register() with its own id.
 *  - "Alive" means: PID exists (kill -0) AND heartbeat is fresh
 *    (lastHeartbeat within HEARTBEAT_TTL_MS). A hung process whose
 *    heartbeat stops will be reported dead even if the PID still exists.
 *  - Stale entries are pruned on every list() — no separate GC needed.
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
  openSync,
} from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'

const RUN_DIR = join(homedir(), '.teya', 'run')
const HEARTBEAT_INTERVAL_MS = 30_000
/** A registered process is considered dead if its heartbeat is older than this. */
const HEARTBEAT_TTL_MS = 90_000

export interface RegisteredProcess {
  id: string
  pid: number
  startedAt: string
  /** Argv to respawn the process: [scriptPath, ...flags]. Excludes node. */
  args: string[]
  description: string
  /** Where stdout/stderr is appended on respawn. */
  logFile: string
  /** ISO timestamp of the last heartbeat write. */
  lastHeartbeat: string
}

interface RegisterOptions {
  /** Path to redirect stdout/stderr on respawn. Defaults to ~/.teya/logs/<id>.log. */
  logFile?: string
  /** Override args used on respawn. Defaults to process.argv.slice(1). */
  args?: string[]
  /** Heartbeat interval in ms. Defaults to 30s. Set to 0 to disable. */
  heartbeatMs?: number
  /**
   * If true (default), install SIGTERM/SIGINT handlers that auto-cleanup
   * the registry file and call process.exit. Set to false when the host
   * process needs to run its own ordered shutdown (e.g. close DBs, stop
   * IPC server) before exiting — in that case the host is responsible for
   * calling process.exit() itself, which triggers our 'exit' handler that
   * still removes the file.
   */
  installSignalHandlers?: boolean
}

// ── Internals ──────────────────────────────────────────────────────────────

function fileFor(id: string): string {
  return join(RUN_DIR, `${id}.json`)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readEntry(id: string): RegisteredProcess | null {
  try {
    return JSON.parse(readFileSync(fileFor(id), 'utf-8')) as RegisteredProcess
  } catch {
    return null
  }
}

function writeEntry(entry: RegisteredProcess): void {
  mkdirSync(RUN_DIR, { recursive: true })
  writeFileSync(fileFor(entry.id), JSON.stringify(entry, null, 2), 'utf-8')
}

function isEntryAlive(entry: RegisteredProcess): boolean {
  if (!isPidAlive(entry.pid)) return false
  // Heartbeat freshness check — catches hung daemons whose PID still exists
  // but whose event loop is wedged. We ALWAYS run the heartbeat in
  // register(), so a missing or stale heartbeat is a real signal.
  const age = Date.now() - new Date(entry.lastHeartbeat).getTime()
  return age <= HEARTBEAT_TTL_MS
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Internal bookkeeping so register() can be called repeatedly (or its
 * resources released via unregister()) without leaking heartbeat timers
 * or process listeners.
 */
interface ActiveRegistration {
  heartbeatTimer: ReturnType<typeof setInterval> | null
  exitListener: () => void
  signalListeners: Array<() => void>
}
const activeRegistrations = new Map<string, ActiveRegistration>()

/**
 * Register the current process. Starts a heartbeat timer and installs
 * cleanup hooks for SIGTERM/SIGINT/exit. Idempotent — calling twice with
 * the same id releases the previous registration first.
 */
export function register(id: string, description: string, opts: RegisterOptions = {}): void {
  // Idempotent — release any prior registration for this id first so we
  // never leak heartbeat timers or process listeners.
  releaseRegistration(id)

  const args = opts.args ?? process.argv.slice(1)
  const logFile = opts.logFile ?? join(homedir(), '.teya', 'logs', `${id}.log`)
  const now = new Date().toISOString()

  const entry: RegisteredProcess = {
    id,
    pid: process.pid,
    startedAt: now,
    args,
    description,
    logFile,
    lastHeartbeat: now,
  }
  writeEntry(entry)

  // Heartbeat — single source of truth for liveness. Wrapped in try/catch
  // because a transient I/O error must not kill the daemon.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  const interval = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS
  if (interval > 0) {
    heartbeatTimer = setInterval(() => {
      try {
        const cur = readEntry(id)
        if (!cur || cur.pid !== process.pid) return // someone else owns the slot
        cur.lastHeartbeat = new Date().toISOString()
        writeEntry(cur)
      } catch {
        /* swallow — try again next tick */
      }
    }, interval)
    // unref so an idle heartbeat doesn't keep the process alive on its own
    if (heartbeatTimer.unref) heartbeatTimer.unref()
  }

  // 'exit' always runs — covers normal exit, process.exit() and uncaught
  // exceptions. Only deletes the file if WE own the slot (guards against a
  // stale unlink racing with a successor process).
  const exitListener = () => {
    const cur = readEntry(id)
    if (cur && cur.pid === process.pid) {
      try { unlinkSync(fileFor(id)) } catch {}
    }
  }
  process.on('exit', exitListener)

  // Signal handlers are opt-in. Daemons with their own ordered shutdown
  // (close DBs, stop IPC, etc) should set installSignalHandlers: false and
  // call process.exit() themselves once shutdown completes — that triggers
  // the 'exit' handler above and the file gets removed cleanly.
  const signalListeners: Array<() => void> = []
  if (opts.installSignalHandlers !== false) {
    const onSig = () => process.exit(0)
    process.on('SIGTERM', onSig)
    process.on('SIGINT', onSig)
    signalListeners.push(onSig)
  }

  activeRegistrations.set(id, { heartbeatTimer, exitListener, signalListeners })
}

/**
 * Release any in-process resources held by register() for `id` and remove
 * the registry file. Use in tests, in long-lived processes that want to
 * cleanly drop their registration, and as the inverse of register().
 */
export function unregister(id: string): void {
  releaseRegistration(id)
  try { unlinkSync(fileFor(id)) } catch {}
}

function releaseRegistration(id: string): void {
  const reg = activeRegistrations.get(id)
  if (!reg) return
  if (reg.heartbeatTimer) clearInterval(reg.heartbeatTimer)
  process.removeListener('exit', reg.exitListener)
  for (const l of reg.signalListeners) {
    process.removeListener('SIGTERM', l)
    process.removeListener('SIGINT', l)
  }
  activeRegistrations.delete(id)
}

/** Look up one registered entry. Returns null if not registered or dead. */
export function get(id: string): RegisteredProcess | null {
  const entry = readEntry(id)
  if (!entry) return null
  if (!isEntryAlive(entry)) {
    try { unlinkSync(fileFor(id)) } catch {}
    return null
  }
  return entry
}

/** List currently-alive registered processes. Auto-prunes dead/stale entries. */
export function list(): RegisteredProcess[] {
  if (!existsSync(RUN_DIR)) return []
  const out: RegisteredProcess[] = []
  for (const f of readdirSync(RUN_DIR)) {
    if (!f.endsWith('.json')) continue
    const path = join(RUN_DIR, f)
    try {
      const entry = JSON.parse(readFileSync(path, 'utf-8')) as RegisteredProcess
      if (isEntryAlive(entry)) {
        out.push(entry)
      } else {
        try { unlinkSync(path) } catch {}
      }
    } catch {
      try { unlinkSync(path) } catch {}
    }
  }
  return out
}

/**
 * Stop a registered process gracefully (SIGTERM, then SIGKILL after timeout).
 * Removes the registry file. Returns true if the process was running.
 */
export async function stop(id: string, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const entry = readEntry(id)
  if (!entry) return false

  if (!isPidAlive(entry.pid)) {
    try { unlinkSync(fileFor(id)) } catch {}
    return false
  }

  try { process.kill(entry.pid, 'SIGTERM') } catch {}

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && isPidAlive(entry.pid)) {
    await new Promise(r => setTimeout(r, 100))
  }
  if (isPidAlive(entry.pid)) {
    try { process.kill(entry.pid, 'SIGKILL') } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  try { unlinkSync(fileFor(id)) } catch {}
  return true
}

/**
 * Spawn a registered process detached, redirecting stdio to its log file.
 * Returns the new pid. The new process must register() itself on startup.
 */
function respawn(entry: RegisteredProcess): number {
  mkdirSync(join(homedir(), '.teya', 'logs'), { recursive: true })
  const out = openSync(entry.logFile, 'a')
  const child = spawn(process.execPath, entry.args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  })
  child.unref()
  return child.pid || 0
}

/**
 * Restart every registered process EXCEPT excludePid (typically the caller's
 * own PID, so an interactive `/update` doesn't kill itself before finishing).
 */
export async function restartAll(opts: { excludePid?: number; log?: (msg: string) => void } = {}): Promise<RegisteredProcess[]> {
  const log = opts.log || (() => {})
  const procs = list().filter(p => p.pid !== opts.excludePid)
  const restarted: RegisteredProcess[] = []

  for (const proc of procs) {
    log(`  ${proc.id} (pid ${proc.pid}) → stopping...`)
    const wasRunning = await stop(proc.id)
    if (!wasRunning) continue

    // Brief pause so the OS releases sockets / Telegram session locks.
    await new Promise(r => setTimeout(r, 500))

    const newPid = respawn(proc)
    log(`  ${proc.id} → started (pid ${newPid}, log ${proc.logFile})`)
    restarted.push({ ...proc, pid: newPid, startedAt: new Date().toISOString() })
  }
  return restarted
}

/** True if a process with the given id is registered AND alive. */
export function isAlive(id: string): boolean {
  return get(id) !== null
}

/** Where registry files live. Exported for diagnostic / migration tools. */
export function getRunDir(): string {
  return RUN_DIR
}
