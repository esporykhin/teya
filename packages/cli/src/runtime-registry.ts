/**
 * @description Registry of long-running teya processes (Telegram bot,
 *  scheduler daemon, etc) so `teya update` can restart them after a build.
 *
 * Without this, the npm-link binary on disk gets updated but the running
 * process keeps the OLD code in RAM until manually killed. That's how a
 * Telegram-bot can quietly serve a stale build for days.
 *
 * Storage:
 *   ~/.teya/run/<id>.json   { id, pid, startedAt, args, description, logFile }
 *
 * The id is per-role ('telegram', 'telegram-userbot', 'scheduler') so each
 * role has at most one entry. Stale entries (PID gone) are auto-cleaned on
 * any read.
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync, existsSync, openSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'

const RUN_DIR = join(homedir(), '.teya', 'run')

export interface RegisteredProcess {
  id: string
  pid: number
  startedAt: string
  /** Full argv to respawn the process: [entryPoint, ...flags]. Excludes node. */
  args: string[]
  description: string
  /** Where stdout/stderr should go on respawn. */
  logFile: string
}

function fileFor(id: string): string {
  return join(RUN_DIR, `${id}.json`)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Register the current process under `id`. Auto-cleans up the registry file
 * on graceful exit (SIGTERM/SIGINT/exit). Call this from background-mode
 * entry points (telegram bot, scheduler) right after startup.
 */
export function register(id: string, description: string, logFile?: string): void {
  mkdirSync(RUN_DIR, { recursive: true })
  // Skip script name (process.argv[0] = node, [1] = script). The respawner
  // will re-prepend node via process.execPath.
  const args = process.argv.slice(1)
  const log = logFile || join(homedir(), '.teya', 'logs', `${id}.log`)
  const entry: RegisteredProcess = {
    id,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    args,
    description,
    logFile: log,
  }
  writeFileSync(fileFor(id), JSON.stringify(entry, null, 2), 'utf-8')

  const cleanup = () => {
    try { unlinkSync(fileFor(id)) } catch {}
  }
  process.on('exit', cleanup)
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
  process.on('SIGINT', () => { cleanup(); process.exit(0) })
}

/** List currently-registered processes. Auto-prunes dead PIDs from disk. */
export function list(): RegisteredProcess[] {
  if (!existsSync(RUN_DIR)) return []
  const out: RegisteredProcess[] = []
  for (const f of readdirSync(RUN_DIR)) {
    if (!f.endsWith('.json')) continue
    const path = join(RUN_DIR, f)
    try {
      const entry = JSON.parse(readFileSync(path, 'utf-8')) as RegisteredProcess
      if (isAlive(entry.pid)) {
        out.push(entry)
      } else {
        try { unlinkSync(path) } catch {}
      }
    } catch {
      // Corrupt file — drop it.
      try { unlinkSync(path) } catch {}
    }
  }
  return out
}

/**
 * Stop a single registered process gracefully (SIGTERM, then SIGKILL after
 * 5s). Removes the registry file on success. Returns true if it was running.
 */
export async function stop(id: string): Promise<boolean> {
  const path = fileFor(id)
  if (!existsSync(path)) return false
  let entry: RegisteredProcess
  try { entry = JSON.parse(readFileSync(path, 'utf-8')) as RegisteredProcess }
  catch { try { unlinkSync(path) } catch {}; return false }

  if (!isAlive(entry.pid)) {
    try { unlinkSync(path) } catch {}
    return false
  }

  try { process.kill(entry.pid, 'SIGTERM') } catch {}
  // Wait up to 5s for graceful shutdown.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && isAlive(entry.pid)) {
    await new Promise(r => setTimeout(r, 100))
  }
  if (isAlive(entry.pid)) {
    try { process.kill(entry.pid, 'SIGKILL') } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  try { unlinkSync(path) } catch {}
  return true
}

/**
 * Spawn a registered process detached, redirecting stdio to its log file.
 * Returns the new pid. The new process will write its own registry entry
 * via register() so we don't need to do it here.
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
 * Restart every background process EXCEPT the current one (so an interactive
 * `/update` doesn't kill its own CLI before it finishes). Used by the
 * self-update flow.
 */
export async function restartAll(opts: { excludePid?: number; log?: (msg: string) => void } = {}): Promise<RegisteredProcess[]> {
  const log = opts.log || (() => {})
  const procs = list().filter(p => p.pid !== opts.excludePid)
  const restarted: RegisteredProcess[] = []

  for (const p of procs) {
    log(`  ${p.id} (pid ${p.pid}) → stopping...`)
    // Snapshot args/log BEFORE stop() removes the file.
    const snapshot = { ...p }
    const wasRunning = await stop(p.id)
    if (!wasRunning) continue

    // Brief pause so the OS releases sockets / Telegram session lock.
    await new Promise(r => setTimeout(r, 500))

    const newPid = respawn(snapshot)
    log(`  ${p.id} → started (pid ${newPid}, log ${snapshot.logFile})`)
    restarted.push({ ...snapshot, pid: newPid, startedAt: new Date().toISOString() })
  }
  return restarted
}
