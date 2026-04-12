#!/usr/bin/env node
/**
 * @description Scheduler daemon — standalone process that executes scheduled tasks.
 *
 * Lifecycle:
 * 1. Write PID file
 * 2. Open TaskStore (shared SQLite)
 * 3. Load agent registry
 * 4. Start IPC server (Unix socket)
 * 5. Start heartbeat
 * 6. Run catch-up for missed windows
 * 7. Start tick loop (every 60s)
 *
 * Managed by launchd (macOS) for auto-restart.
 * CLI commands: teya scheduler start|stop|status|logs
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { TaskStore } from './task-store.js'
import { CronEngine } from './cron-engine.js'
import { DaemonExecutor } from './daemon-executor.js'
import { IPCServer } from './ipc.js'
import { ensureBuiltinTasks } from './builtin-tasks.js'
import { AgentRegistry } from '@teya/orchestrator'
import { KnowledgeGraph, SessionStore as MemSessionStore, batchSummarize, extractDailyKnowledge } from '@teya/memory'
import { openrouter } from '@teya/providers'
import { initWorkspace } from '@teya/tools'
import { register as registerProcess, get as getRegistered } from '@teya/runtime'

const CONFIG_DIR = join(process.env.HOME || '.', '.teya')
const LOG_PREFIX = '\x1b[90m[scheduler]\x1b[0m'

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19)
  process.stderr.write(`${LOG_PREFIX} ${ts} ${msg}\n`)
}

async function main(): Promise<void> {
  log('Starting...')

  // 1. Register in the shared runtime registry. This writes the PID file,
  //    starts the heartbeat, and installs signal cleanup hooks. The same
  //    @teya/runtime module is used by CLI for `teya update` restart and
  //    `teya runtime list` — single source of truth, no parallel pid files.
  //
  //    Capture the previous heartbeat (from the prior daemon instance, if
  //    any) BEFORE register() overwrites the file — used by catch-up below.
  const previousEntry = getRegistered('scheduler')
  const previousHeartbeat = previousEntry ? new Date(previousEntry.lastHeartbeat) : null
  registerProcess('scheduler', 'Scheduler daemon (cron tasks)', {
    logFile: join(CONFIG_DIR, 'logs', 'scheduler.stderr.log'),
    // We do our own ordered shutdown below — don't let runtime's default
    // signal handlers exit the process before we close DBs / IPC.
    installSignalHandlers: false,
  })

  // 2. Load config
  let config: any = {}
  try {
    config = JSON.parse(await readFile(join(CONFIG_DIR, 'config.json'), 'utf-8'))
  } catch {
    log('No config.json found — will use agent-level provider configs only')
  }

  // 3. Task store
  const store = new TaskStore()
  const orphaned = store.cleanupOrphanedExecutions()
  if (orphaned > 0) log(`Cleaned ${orphaned} orphaned executions`)
  const pruned = store.pruneExecutions(30)
  if (pruned > 0) log(`Pruned ${pruned} old execution records`)

  // 3a. Ensure built-in tasks exist (idempotent)
  const builtinsCreated = ensureBuiltinTasks(store)
  if (builtinsCreated > 0) log(`Registered ${builtinsCreated} built-in tasks`)

  // 4. Agent registry
  const registry = new AgentRegistry()
  await registry.loadFromDirectory(join(CONFIG_DIR, 'agents'))
  log(`Loaded ${registry.list().length} agents`)

  // 5. Knowledge graph (shared with CLI)
  const kg = new KnowledgeGraph()

  // 6. Workspace
  await initWorkspace()

  // 7. Executor
  const executor = new DaemonExecutor(
    { provider: config.provider || 'openrouter', model: config.model || '', apiKey: config.apiKey || '' },
    registry,
    store,
    kg,
    (task, execId) => log(`Running: [${task.id}] "${task.title}"${task.assignee ? ` → ${task.assignee}` : ''}`),
    (task, result) => log(`Done: [${task.id}] "${task.title}" (${result.length} chars)`),
    (task, error) => log(`Failed: [${task.id}] "${task.title}" — ${error.message}`),
  )

  // 8. Cron engine
  const engine = new CronEngine(store, executor, { maxConcurrent: 3 })

  // 9. Catch-up — use the previous daemon's last heartbeat as the lower
  //    bound for "missed cron windows".
  if (previousHeartbeat) {
    const caught = await engine.catchUp(previousHeartbeat)
    if (caught.length > 0) log(`Catch-up: executing ${caught.length} missed tasks`)
  }

  // 10. IPC server
  const startTime = new Date()
  const ipc = new IPCServer(join(CONFIG_DIR, 'scheduler.sock'), {
    store,
    engine,
    getAgentCount: () => registry.list().length,
    startTime,
  })
  await ipc.start()
  log('IPC server ready')

  // 11. Session intelligence — batch summarize + daily knowledge extraction
  const sessionStore = new MemSessionStore()
  const cheapLLM = createCheapLLM(config)

  // Summarize unsummarized sessions every 10 minutes
  const summaryInterval = setInterval(async () => {
    if (!cheapLLM) return
    try {
      const count = await batchSummarize(sessionStore, cheapLLM, 3)
      if (count > 0) log(`Summarized ${count} sessions`)
    } catch (err) {
      log(`Summary error: ${(err as Error).message}`)
    }
  }, 10 * 60_000)
  if (summaryInterval.unref) summaryInterval.unref()

  // Register built-in task handler: daily knowledge extraction
  executor.registerBuiltin('builtin:daily-knowledge', async (_task, _signal) => {
    if (!cheapLLM) return 'Skipped: no LLM configured'
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    const result = await extractDailyKnowledge(sessionStore, kg, cheapLLM, yesterday)
    const summary = `Extracted ${result.entities} entities, ${result.facts} facts, ${result.relations} relations from ${yesterday}`
    log(`Knowledge extraction: ${summary}`)
    return summary
  })

  // 12. Main loop
  const tickInterval = setInterval(() => engine.tick(), 60_000)
  await engine.tick() // immediate first tick

  const cronTasks = store.listCronTasks()
  log(`Ready. ${cronTasks.length} scheduled tasks, PID ${process.pid}`)

  // 12. Graceful shutdown — drain in order, then exit. The 'exit' event
  //     handler installed by @teya/runtime.register() removes our registry
  //     file regardless of how we exit.
  const shutdown = async (signal: string) => {
    log(`${signal} received, shutting down...`)
    clearInterval(tickInterval)
    clearInterval(summaryInterval)
    await executor.waitForAll(30_000)
    await ipc.stop()
    sessionStore.close()
    kg.close()
    store.close()
    log('Stopped.')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

/** Create a cheap LLM function for summarization / extraction */
function createCheapLLM(config: any): ((system: string, user: string) => Promise<string>) | null {
  const apiKey = config.apiKey
  if (!apiKey) return null

  // Use a cheap fast model for intelligence tasks
  const cheapModel = 'google/gemini-2.0-flash-001'
  const provider = openrouter({ model: cheapModel, apiKey })

  return async (systemPrompt: string, userMessage: string): Promise<string> => {
    const response = await provider.generate({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3,
      maxTokens: 2000,
    })
    return response.content
  }
}

// Crash-fast on uncaught errors. We DON'T silently swallow them — Node's
// own docs warn that "It is not safe to resume normal operation after
// 'uncaughtException'", and a daemon writing to SQLite under a corrupt
// state can lose data. Instead: log → exit(1) → the next teya CLI/Telegram
// startup will spawn a fresh daemon via ensureSchedulerRunning(). The
// runtime registry's 'exit' handler still removes our pid file on the way
// out, so list() / `teya runtime list` reflect reality.
process.on('uncaughtException', err => {
  log(`uncaughtException (exiting): ${err.stack || err.message}`)
  process.exit(1)
})
process.on('unhandledRejection', reason => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason)
  log(`unhandledRejection (exiting): ${msg}`)
  process.exit(1)
})

main().catch(err => {
  log(`Fatal: ${err.message}`)
  process.exit(1)
})
