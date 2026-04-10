/**
 * @description Built-in scheduler tasks — registered at daemon startup.
 *
 * Each built-in has a stable ID and a handler identifier prefixed with "builtin:".
 * The DaemonExecutor recognizes "builtin:" prompts and calls the actual functions
 * directly instead of spawning an LLM session.
 */
import type { TaskStore } from './task-store.js'

export interface BuiltinTaskDef {
  id: string
  title: string
  cron: string
  handler: string      // identifier like "builtin:daily-knowledge"
  description: string
}

export const BUILTIN_TASKS: BuiltinTaskDef[] = [
  {
    id: 'builtin-daily-knowledge',
    title: 'Extract daily knowledge from sessions',
    cron: '0 3 * * *',
    handler: 'builtin:daily-knowledge',
    description: 'Analyzes all sessions from the previous day and extracts entities, facts, and relations into the knowledge graph',
  },
]

/**
 * Ensure built-in tasks exist in the task store. Idempotent — safe to call on every startup.
 * Returns the number of tasks actually created (0 if all already existed).
 */
export function ensureBuiltinTasks(store: TaskStore): number {
  let created = 0
  for (const bt of BUILTIN_TASKS) {
    const existing = store.get(bt.id)
    if (existing) continue

    store.createWithId(bt.id, {
      title: bt.title,
      cron: bt.cron,
      prompt: bt.handler,
      description: bt.description,
      tags: ['builtin'],
      createdBy: 'system',
    })
    created++
  }
  return created
}
