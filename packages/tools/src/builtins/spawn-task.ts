/**
 * @description core:spawn_task, core:check_task — background command execution
 */
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import type { ToolDefinition } from '@teya/core'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

interface Task {
  status: 'running' | 'completed' | 'failed'
  output: string
  command: string
  startedAt: number
}

// Simple in-memory task store
const tasks = new Map<string, Task>()

export const spawnTaskTool: RegisteredTool = {
  name: 'core:spawn_task',
  description:
    'Run a command in the background. Returns a task ID immediately. Use core:check_task to check the result later.',
  parameters: {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'Shell command to run in background' },
      cwd: { type: 'string', description: 'Working directory' },
    },
    required: ['command'],
  },
  source: 'builtin' as const,
  cost: {
    latency: 'instant' as const,
    tokenCost: 'none' as const,
    sideEffects: true,
    reversible: false,
    external: false,
  },
  execute: async (args: Record<string, unknown>) => {
    const command = args.command as string
    const cwd = (args.cwd as string) || process.cwd()
    const taskId = randomUUID().slice(0, 8)

    tasks.set(taskId, { status: 'running', output: '', command, startedAt: Date.now() })

    const proc = spawn('sh', ['-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    proc.stdout?.on('data', (data: Buffer) => {
      output += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      output += data.toString()
    })

    proc.on('close', (code) => {
      const task = tasks.get(taskId)
      if (task) {
        task.status = code === 0 ? 'completed' : 'failed'
        task.output = output.trim() || `(exited with code ${code})`
      }
    })

    proc.on('error', (err) => {
      const task = tasks.get(taskId)
      if (task) {
        task.status = 'failed'
        task.output = `Error: ${err.message}`
      }
    })

    return `Task ${taskId} started: ${command}`
  },
}

export const checkTaskTool: RegisteredTool = {
  name: 'core:check_task',
  description:
    'Check the status and output of a background task started with core:spawn_task.',
  parameters: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task ID returned by spawn_task' },
    },
    required: ['task_id'],
  },
  source: 'builtin' as const,
  cost: {
    latency: 'instant' as const,
    tokenCost: 'low' as const,
    sideEffects: false,
    reversible: true,
    external: false,
  },
  execute: async (args: Record<string, unknown>) => {
    const taskId = args.task_id as string
    const task = tasks.get(taskId)
    if (!task) return `Task ${taskId} not found.`

    const elapsed = Math.floor((Date.now() - task.startedAt) / 1000)

    if (task.status === 'running') {
      return `Task ${taskId} still running (${elapsed}s). Command: ${task.command}`
    }

    return `Task ${taskId} ${task.status} (${elapsed}s):\n${task.output}`
  },
}
