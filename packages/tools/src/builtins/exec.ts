/**
 * @description core:exec — execute shell commands
 */
import { execSync } from 'child_process'
import type { ToolDefinition } from '@teya/core'
import { getWorkspaceRoot } from '../workspace.js'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

export const execTool: RegisteredTool = {
  name: 'core:exec',
  description: 'Run a shell command and wait for result. Use for: git, npm/pip install, ls, grep, curl, any CLI tool. Blocks until done (max 30s). For long-running commands use core:spawn_task instead.',
  parameters: {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute. Can be any valid bash command.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Defaults to current directory.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds. Default 30000 (30 seconds).',
      },
    },
    required: ['command'],
  },
  source: 'builtin' as const,
  cost: {
    latency: 'slow' as const,
    tokenCost: 'high' as const,
    sideEffects: true,
    reversible: false,
    external: false,
  },
  timeout: 60000,
  execute: async (args: Record<string, unknown>) => {
    const command = args.command as string
    const cwd = (args.cwd as string) || getWorkspaceRoot()
    const timeout = (args.timeout as number) || 30000

    try {
      const output = execSync(command, {
        cwd,
        timeout,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024, // 1MB
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const result = output.trim()
      return result || '(command completed with no output)'
    } catch (error: unknown) {
      const err = error as { status?: number; stderr?: string; stdout?: string; message?: string }
      const stderr = err.stderr?.trim() || ''
      const stdout = err.stdout?.trim() || ''
      const code = err.status ?? 'unknown'

      return `Exit code ${code}\n${stderr || stdout || err.message || 'Unknown error'}`
    }
  },
}
