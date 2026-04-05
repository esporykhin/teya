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
import { HealthManager } from './health.js'
import { AgentRegistry } from '@teya/orchestrator'
import { KnowledgeGraph, SessionStore as MemSessionStore, batchSummarize, extractDailyKnowledge } from '@teya/memory'
import { openrouter } from '@teya/providers'
import { initWorkspace } from '@teya/tools'

const CONFIG_DIR = join(process.env.HOME || '.', '.teya')
const LOG_PREFIX = '\x1b[90m[scheduler]\x1b[0m'

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19)
  process.stderr.write(`${LOG_PREFIX} ${ts} ${msg}\n`)
}

async function main(): Promise<void> {
  log('Starting...')

  // 1. Health & PID
  const health = new HealthManager(CONFIG_DIR)
  health.writePid()
  health.startHeartbeat(10_000)

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

  // 9. Catch-up
  const lastBeat = health.readLastHeartbeat()
  if (lastBeat) {
    const caught = await engine.catchUp(lastBeat)
    if (caught.length > 0) log(`Catch-up: executing ${caught.length} missed tasks`)
  }

  // 10. IPC server
  const startTime = new Date()
  const ipc = new IPCServer(join(CONFIG_DIR, 'scheduler.sock'), {
    store,
    engine,
    health,
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

  // Daily knowledge extraction at 3:00 AM
  const knowledgeInterval = setInterval(async () => {
    if (!cheapLLM) return
    const now = new Date()
    if (now.getHours() !== 3 || now.getMinutes() !== 0) return
    try {
      const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10)
      const result = await extractDailyKnowledge(sessionStore, kg, cheapLLM, yesterday)
      if (result.entities > 0 || result.facts > 0) {
        log(`Knowledge extraction: ${result.entities} entities, ${result.facts} facts, ${result.relations} relations`)
      }
    } catch (err) {
      log(`Knowledge extraction error: ${(err as Error).message}`)
    }
  }, 60_000)
  if (knowledgeInterval.unref) knowledgeInterval.unref()

  // 12. Main loop
  const tickInterval = setInterval(() => engine.tick(), 60_000)
  await engine.tick() // immediate first tick

  const cronTasks = store.listCronTasks()
  log(`Ready. ${cronTasks.length} scheduled tasks, PID ${process.pid}`)

  // 12. Graceful shutdown
  const shutdown = async (signal: string) => {
    log(`${signal} received, shutting down...`)
    clearInterval(tickInterval)
    clearInterval(summaryInterval)
    clearInterval(knowledgeInterval)
    await executor.waitForAll(30_000)
    await ipc.stop()
    health.cleanup()
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

main().catch(err => {
  log(`Fatal: ${err.message}`)
  process.exit(1)
})
