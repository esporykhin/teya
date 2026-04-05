/**
 * @description core:tasks — unified task management tool.
 *
 * Actions:
 *   create   — create task (one-off or cron)
 *   list     — list tasks with filters
 *   update   — update task status/details
 *   get      — full task details + execution history
 *   schedule — manage cron tasks (list, pause, resume, trigger, delete)
 */
import type { ToolDefinition } from '@teya/core'
import { TaskStore, type CreateTaskInput, type TaskPriority, type TaskStatus } from './task-store.js'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

const CRON_HELP = `Cron: min hour day month weekday. E.g. "0 9 * * 1" = Mon 9am, "*/30 * * * *" = every 30min`

export function createTaskTools(store: TaskStore): {
  tasksTool: RegisteredTool
  scheduleTool: RegisteredTool
  // Legacy aliases
  taskCreate: RegisteredTool
  taskList: RegisteredTool
  taskUpdate: RegisteredTool
  taskGet: RegisteredTool
  schedule: RegisteredTool
} {
  const tasksTool: RegisteredTool = {
    name: 'core:tasks',
    description: `Task management. Actions:
  create — create task (set prompt + cron for auto-execution by scheduler)
  list   — list tasks (filter by status, priority, assignee, tag)
  update — change status, priority, assignee, prompt, etc.
  get    — full details + recent execution history
  delete — remove a task`,
    parameters: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'get', 'delete'], description: 'Action' },
        // create
        title: { type: 'string', description: 'Task title (create)' },
        description: { type: 'string', description: 'Description (create/update)' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Priority (create/update)' },
        due_at: { type: 'string', description: 'Due date ISO (create/update)' },
        cron: { type: 'string', description: `Cron expression (create/update). ${CRON_HELP}` },
        prompt: { type: 'string', description: 'Agent prompt for auto-execution (create/update)' },
        assignee: { type: 'string', description: 'Agent ID (create/update)' },
        tags: { type: 'string', description: 'Comma-separated tags (create/update)' },
        timezone: { type: 'string', description: 'IANA timezone, default Europe/Moscow (create)' },
        max_retries: { type: 'number', description: 'Retries on failure (create)' },
        // update/get/delete
        id: { type: 'string', description: 'Task ID (update/get/delete)' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled'], description: 'New status (update)' },
        result: { type: 'string', description: 'Result (update)' },
        enabled: { type: 'boolean', description: 'Enable/disable (update)' },
        // list filters
        limit: { type: 'number', description: 'Max results (list)' },
        tag: { type: 'string', description: 'Filter by tag (list)' },
      },
      required: ['action'],
    },
    source: 'builtin' as const,
    cost: { latency: 'instant' as const, tokenCost: 'low' as const, sideEffects: true, reversible: true, external: false },
    execute: async (args: Record<string, unknown>) => {
      const action = args.action as string

      switch (action) {
        case 'create': {
          if (!args.title) return 'Need title for create.'
          const input: CreateTaskInput = {
            title: args.title as string,
            description: (args.description as string) || undefined,
            priority: (args.priority as TaskPriority) || undefined,
            dueAt: (args.due_at as string) || undefined,
            cron: (args.cron as string) || undefined,
            prompt: (args.prompt as string) || undefined,
            assignee: (args.assignee as string) || undefined,
            createdBy: 'agent',
            tags: args.tags ? (args.tags as string).split(',').map(t => t.trim()) : undefined,
            timezone: (args.timezone as string) || undefined,
            maxRetries: (args.max_retries as number) || undefined,
          }
          const task = store.create(input)
          const parts = [`Task ${task.id}: "${task.title}"`]
          if (task.cron) parts.push(`Cron: ${task.cron} (${task.timezone})`)
          if (task.dueAt) parts.push(`Due: ${task.dueAt}`)
          if (task.assignee) parts.push(`Agent: ${task.assignee}`)
          if (task.prompt) parts.push('Auto-execution: enabled')
          return parts.join('\n')
        }

        case 'list': {
          const statusArg = args.status as string | undefined
          const status = statusArg === 'all' ? undefined
            : statusArg ? statusArg as TaskStatus
            : ['pending', 'in_progress'] as TaskStatus[]

          const tasks = store.list({
            status,
            priority: args.priority as TaskPriority | undefined,
            assignee: args.assignee as string | undefined,
            tag: args.tag as string | undefined,
            limit: (args.limit as number) || 20,
          })
          if (tasks.length === 0) return 'No tasks found.'

          return tasks.map(t => {
            const parts = [`[${t.id}] ${icon(t.status)} ${t.title}`]
            if (t.priority !== 'medium') parts[0] += ` (${t.priority})`
            if (t.assignee) parts.push(`  agent: ${t.assignee}`)
            if (t.cron) parts.push(`  cron: ${t.cron} (${t.timezone})`)
            if (t.dueAt) parts.push(`  due: ${t.dueAt}`)
            if (t.tags.length > 0) parts.push(`  tags: ${t.tags.join(', ')}`)
            if (t.lastRunAt) parts.push(`  last run: ${t.lastRunAt}`)
            return parts.join('\n')
          }).join('\n')
        }

        case 'update': {
          if (!args.id) return 'Need id for update.'
          const updates: Record<string, unknown> = {}
          for (const key of ['status', 'title', 'description', 'priority', 'assignee', 'result', 'prompt']) {
            if (args[key] !== undefined) updates[key] = args[key]
          }
          if (args.due_at !== undefined) updates.dueAt = args.due_at
          if (args.cron !== undefined) updates.cron = args.cron || null
          if (args.enabled !== undefined) updates.enabled = args.enabled
          if (args.tags !== undefined) updates.tags = (args.tags as string).split(',').map(t => t.trim())

          const task = store.update(args.id as string, updates as any)
          if (!task) return `Task ${args.id} not found.`
          return `Updated [${task.id}] ${icon(task.status)} "${task.title}"`
        }

        case 'get': {
          if (!args.id) return 'Need id for get.'
          const task = store.get(args.id as string)
          if (!task) return `Task ${args.id} not found.`

          const lines = [
            `[${task.id}] ${icon(task.status)} ${task.title}`,
            `Priority: ${task.priority} | Created: ${task.createdBy}`,
          ]
          if (task.description) lines.push(`Description: ${task.description}`)
          if (task.assignee) lines.push(`Agent: ${task.assignee}`)
          if (task.dueAt) lines.push(`Due: ${task.dueAt}`)
          if (task.cron) lines.push(`Cron: ${task.cron} (${task.timezone})`)
          if (task.prompt) lines.push(`Prompt: ${task.prompt.slice(0, 200)}`)
          if (task.lastRunAt) lines.push(`Last run: ${task.lastRunAt}`)
          if (task.result) lines.push(`Result: ${task.result.slice(0, 300)}`)
          if (!task.enabled) lines.push('** DISABLED **')

          const execs = store.getExecutions(task.id, 5)
          if (execs.length > 0) {
            lines.push('\nExecutions:')
            for (const e of execs) {
              const dur = e.finishedAt
                ? `${((new Date(e.finishedAt).getTime() - new Date(e.startedAt).getTime()) / 1000).toFixed(0)}s`
                : 'running'
              lines.push(`  ${e.startedAt.slice(0, 16)} ${icon(e.status === 'completed' ? 'completed' : 'failed')} ${dur}${e.error ? ` — ${e.error}` : ''}`)
            }
          }
          return lines.join('\n')
        }

        case 'delete': {
          if (!args.id) return 'Need id for delete.'
          return store.delete(args.id as string) ? `Deleted task ${args.id}.` : `Task ${args.id} not found.`
        }

        default:
          return `Unknown action: ${action}. Use: create, list, update, get, delete`
      }
    },
  }

  const scheduleTool: RegisteredTool = {
    name: 'core:schedule',
    description: `Manage scheduled (cron) tasks. Actions:
  list    — show all cron tasks
  pause   — disable a cron task
  resume  — re-enable a cron task
  trigger — execute immediately
  delete  — remove a scheduled task`,
    parameters: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'pause', 'resume', 'trigger', 'delete'], description: 'Action' },
        id: { type: 'string', description: 'Task ID (pause/resume/trigger/delete)' },
      },
      required: ['action'],
    },
    source: 'builtin' as const,
    cost: { latency: 'instant' as const, tokenCost: 'low' as const, sideEffects: true, reversible: true, external: false },
    execute: async (args: Record<string, unknown>) => {
      const action = args.action as string
      const id = args.id as string | undefined

      switch (action) {
        case 'list': {
          const tasks = store.listCronTasks()
          if (tasks.length === 0) return 'No scheduled tasks.'
          return tasks.map(t =>
            `[${t.id}] ${t.enabled ? icon(t.status) : '[-]'} "${t.title}" ${t.cron} (${t.timezone})${t.assignee ? ` -> ${t.assignee}` : ''}${t.lastRunAt ? ` last: ${t.lastRunAt.slice(0, 16)}` : ''}`
          ).join('\n')
        }
        case 'pause': {
          if (!id) return 'Need task id.'
          const task = store.update(id, { enabled: false })
          return task ? `Paused: "${task.title}"` : `Task ${id} not found.`
        }
        case 'resume': {
          if (!id) return 'Need task id.'
          const task = store.update(id, { enabled: true, status: 'pending' })
          return task ? `Resumed: "${task.title}"` : `Task ${id} not found.`
        }
        case 'trigger': {
          if (!id) return 'Need task id.'
          const task = store.get(id)
          if (!task) return `Task ${id} not found.`
          store.update(id, { status: 'pending', dueAt: new Date().toISOString() })
          return `Queued: "${task.title}"`
        }
        case 'delete': {
          if (!id) return 'Need task id.'
          return store.delete(id) ? `Deleted task ${id}.` : `Task ${id} not found.`
        }
        default:
          return `Unknown action: ${action}. Use: list, pause, resume, trigger, delete`
      }
    },
  }

  return {
    tasksTool, scheduleTool,
    taskCreate: tasksTool, taskList: tasksTool,
    taskUpdate: tasksTool, taskGet: tasksTool, schedule: scheduleTool,
  }
}

function icon(status: string): string {
  switch (status) {
    case 'pending': return '[ ]'; case 'in_progress': return '[~]'
    case 'completed': return '[x]'; case 'failed': return '[!]'
    case 'cancelled': return '[-]'; default: return '[?]'
  }
}
