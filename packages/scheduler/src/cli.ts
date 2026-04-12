/**
 * @description CLI subcommands for scheduler management.
 *
 * teya scheduler start    — start daemon (detached)
 * teya scheduler stop     — stop daemon (SIGTERM)
 * teya scheduler status   — show daemon status via IPC
 * teya scheduler logs     — show execution history
 * teya scheduler install  — install launchd plist for auto-start
 * teya scheduler uninstall — remove launchd plist
 */
import { spawn } from 'child_process'
import { join } from 'path'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { HealthManager } from './health.js'
import { createIPCClient } from './ipc.js'
import { TaskStore } from './task-store.js'

const CONFIG_DIR = join(process.env.HOME || '.', '.teya')
const PLIST_LABEL = 'com.teya.scheduler'
const PLIST_PATH = join(process.env.HOME || '.', 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`)

export interface EnsureSchedulerResult {
  pid: number
  /** True if the daemon was already running before this call. */
  alreadyRunning: boolean
  /** Path to the daemon entry point that was spawned (or would be on respawn). */
  daemonPath: string
}

/**
 * Ensure the scheduler daemon is running. Idempotent — if already alive,
 * returns its PID. Otherwise spawns a detached child process and waits up
 * to 1.5s for it to come up. Used by:
 *   - `teya scheduler start` (explicit invocation)
 *   - main `teya` startup (auto-bootstrap so cron tasks fire out of the box)
 */
export async function ensureSchedulerRunning(opts: { silent?: boolean } = {}): Promise<EnsureSchedulerResult | null> {
  const log = opts.silent ? () => {} : (msg: string) => console.log(msg)
  const daemonPath = join(import.meta.dirname, 'daemon.js')

  const health = HealthManager.isAlive(CONFIG_DIR)
  if (health.alive) {
    return { pid: health.pid!, alreadyRunning: true, daemonPath }
  }

  const logsDir = join(CONFIG_DIR, 'logs')
  mkdirSync(logsDir, { recursive: true })

  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' },
  })

  const { createWriteStream } = await import('fs')
  const stdout = createWriteStream(join(logsDir, 'scheduler.stdout.log'), { flags: 'a' })
  const stderr = createWriteStream(join(logsDir, 'scheduler.stderr.log'), { flags: 'a' })
  child.stdout?.pipe(stdout)
  child.stderr?.pipe(stderr)
  child.unref()

  // Wait briefly for the daemon to write its PID file via HealthManager.
  await new Promise(resolve => setTimeout(resolve, 1500))
  const newHealth = HealthManager.isAlive(CONFIG_DIR)
  if (newHealth.alive) {
    log(`Scheduler started (PID ${newHealth.pid})`)
    return { pid: newHealth.pid!, alreadyRunning: false, daemonPath }
  }
  log('Failed to start scheduler. Check logs: ~/.teya/logs/scheduler.stderr.log')
  return null
}

export async function handleSchedulerCommand(args: string[]): Promise<void> {
  const action = args[0]

  switch (action) {
    case 'start': {
      const result = await ensureSchedulerRunning()
      if (result?.alreadyRunning) {
        console.log(`Scheduler already running (PID ${result.pid})`)
      }
      break
    }

    case 'stop': {
      const health = HealthManager.isAlive(CONFIG_DIR)
      if (!health.alive) {
        console.log('Scheduler is not running')
        return
      }
      try {
        process.kill(health.pid!, 'SIGTERM')
        console.log(`Scheduler stopped (PID ${health.pid})`)
      } catch {
        console.error(`Failed to stop scheduler (PID ${health.pid})`)
      }
      break
    }

    case 'status': {
      const health = HealthManager.isAlive(CONFIG_DIR)
      if (!health.alive) {
        console.log('Scheduler: not running')

        // Show task count anyway
        try {
          const store = new TaskStore()
          const cronTasks = store.listCronTasks()
          const pendingTasks = store.list({ status: 'pending' })
          console.log(`Tasks: ${pendingTasks.length} pending, ${cronTasks.length} scheduled`)
          store.close()
        } catch {}
        return
      }

      const client = createIPCClient()
      try {
        const res = await client.send({ type: 'status' })
        if (res.type === 'status') {
          const d = res.data
          console.log(`Scheduler: running (PID ${d.pid})`)
          console.log(`Uptime: ${formatDuration(d.uptime)}`)
          console.log(`Active tasks: ${d.activeTasks.length > 0 ? d.activeTasks.join(', ') : 'none'}`)
          console.log(`Agents: ${d.agentCount}`)
          console.log(`Total executions: ${d.totalExecutions}`)
          if (d.lastTick) console.log(`Last tick: ${d.lastTick}`)
        }
      } catch {
        console.log(`Scheduler: running (PID ${health.pid}) but IPC not responding`)
      }
      break
    }

    case 'logs': {
      const taskId = args[1]
      const limit = parseInt(args[2] || '20', 10)

      // Read directly from DB (works even if daemon is not running)
      const store = new TaskStore()
      const executions = store.getExecutions(taskId, limit)
      store.close()

      if (executions.length === 0) {
        console.log('No execution history.')
        return
      }

      for (const exec of executions) {
        const duration = exec.finishedAt
          ? `${((new Date(exec.finishedAt).getTime() - new Date(exec.startedAt).getTime()) / 1000).toFixed(1)}s`
          : 'running'
        const cost = exec.costUsd > 0 ? ` $${exec.costUsd.toFixed(4)}` : ''
        const tokens = exec.tokenUsageInput + exec.tokenUsageOutput > 0
          ? ` ${exec.tokenUsageInput + exec.tokenUsageOutput}tok`
          : ''

        const statusIcon = exec.status === 'completed' ? '[x]'
          : exec.status === 'failed' ? '[!]'
          : exec.status === 'timeout' ? '[T]'
          : '[~]'

        console.log(`${exec.startedAt.slice(0, 19)} ${statusIcon} task=${exec.taskId} agent=${exec.agentId || 'default'} ${duration}${cost}${tokens}`)
        if (exec.error) console.log(`  error: ${exec.error}`)
        if (exec.result && exec.result.length < 200) console.log(`  result: ${exec.result}`)
      }
      break
    }

    case 'install': {
      const nodePath = process.execPath
      const daemonPath = join(import.meta.dirname, 'daemon.js')
      const logsDir = join(CONFIG_DIR, 'logs')
      mkdirSync(logsDir, { recursive: true })

      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${daemonPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${join(logsDir, 'scheduler.stdout.log')}</string>
    <key>StandardErrorPath</key>
    <string>${join(logsDir, 'scheduler.stderr.log')}</string>
    <key>WorkingDirectory</key>
    <string>${CONFIG_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${process.env.HOME}</string>
        <key>PATH</key>
        <string>${process.env.PATH}</string>
    </dict>
</dict>
</plist>`

      writeFileSync(PLIST_PATH, plist)
      try {
        execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'pipe' })
        console.log(`Installed and started: ${PLIST_LABEL}`)
        console.log(`Plist: ${PLIST_PATH}`)
        console.log(`Logs: ${logsDir}`)
      } catch (err) {
        console.log(`Plist written to ${PLIST_PATH}`)
        console.log(`Load manually: launchctl load "${PLIST_PATH}"`)
      }
      break
    }

    case 'uninstall': {
      if (existsSync(PLIST_PATH)) {
        try {
          execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'pipe' })
        } catch {}
        unlinkSync(PLIST_PATH)
        console.log(`Uninstalled: ${PLIST_LABEL}`)
      } else {
        console.log('Scheduler plist not found.')
      }
      break
    }

    default:
      console.log('Usage: teya scheduler <command>')
      console.log('')
      console.log('Commands:')
      console.log('  start       Start scheduler daemon')
      console.log('  stop        Stop scheduler daemon')
      console.log('  status      Show scheduler status')
      console.log('  logs [id]   Show execution history (optionally for a specific task)')
      console.log('  install     Install as launchd service (auto-start on boot)')
      console.log('  uninstall   Remove launchd service')
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}
