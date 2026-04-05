/**
 * @description core:files — unified file operations tool, scoped to workspace.
 *
 * Actions:
 *   read  — read file contents
 *   write — write content to file (creates dirs)
 *   list  — list directory contents with sizes
 *   find  — search files by name pattern
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises'
import { dirname, join, relative } from 'path'
import type { ToolDefinition } from '@teya/core'
import { resolveWorkspacePath, getWorkspaceRoot } from '../workspace.js'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

export const filesTool: RegisteredTool = {
  name: 'core:files',
  description: `File operations in workspace. Actions:
  read  — read file contents
  write — write content to file (auto-creates directories)
  list  — list directory (sizes, types). Default: workspace root
  find  — search files by name pattern (*.md, report*, etc.)

All paths relative to workspace.`,
  parameters: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['read', 'write', 'list', 'find'], description: 'Action' },
      path: { type: 'string', description: 'File/directory path relative to workspace' },
      content: { type: 'string', description: 'Content to write (write action)' },
      pattern: { type: 'string', description: 'File name pattern, e.g. "*.md" (find action)' },
    },
    required: ['action'],
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
    const action = args.action as string

    switch (action) {
      case 'read': {
        if (!args.path) return 'Need path for read.'
        try {
          const resolved = resolveWorkspacePath(args.path as string, 'read')
          return await readFile(resolved, 'utf-8')
        } catch (err) {
          return `Error: ${(err as Error).message}`
        }
      }

      case 'write': {
        if (!args.path) return 'Need path for write.'
        if (args.content === undefined) return 'Need content for write.'
        try {
          const resolved = resolveWorkspacePath(args.path as string, 'write')
          await mkdir(dirname(resolved), { recursive: true })
          await writeFile(resolved, args.content as string, 'utf-8')
          const rel = relative(getWorkspaceRoot(), resolved)
          return `Written ${(args.content as string).length} chars to ${rel}`
        } catch (err) {
          return `Error: ${(err as Error).message}`
        }
      }

      case 'list': {
        try {
          const dirPath = (args.path as string) || '.'
          const resolved = resolveWorkspacePath(dirPath, 'read')
          const entries = await readdir(resolved, { withFileTypes: true })
          if (entries.length === 0) return `(empty directory)`

          const lines: string[] = []
          for (const entry of entries) {
            if (entry.isDirectory()) {
              lines.push(`  ${entry.name}/`)
            } else {
              const fileStat = await stat(join(resolved, entry.name))
              lines.push(`  ${entry.name}  (${formatSize(fileStat.size)})`)
            }
          }
          const rel = relative(getWorkspaceRoot(), resolved) || '.'
          return `${rel}/\n${lines.join('\n')}`
        } catch (err) {
          return `Error: ${(err as Error).message}`
        }
      }

      case 'find': {
        if (!args.pattern) return 'Need pattern for find.'
        try {
          const searchPath = (args.path as string) || '.'
          const resolved = resolveWorkspacePath(searchPath, 'read')
          const matches: string[] = []
          await walkDir(resolved, getWorkspaceRoot(), (args.pattern as string).toLowerCase(), matches)
          if (matches.length === 0) return `No files matching "${args.pattern}".`
          return matches.join('\n')
        } catch (err) {
          return `Error: ${(err as Error).message}`
        }
      }

      default:
        return `Unknown action: ${action}. Use: read, write, list, find`
    }
  },
}

// Legacy exports for backward compatibility
export const readFileTool = filesTool
export const writeFileTool = filesTool
export const listDirTool = filesTool
export const findFilesTool = filesTool

// ── Helpers ──────────────────────────────────────────────────────────────────

async function walkDir(dir: string, root: string, pattern: string, results: string[], depth = 0): Promise<void> {
  if (depth > 10) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkDir(fullPath, root, pattern, results, depth + 1)
    } else if (matchGlob(entry.name.toLowerCase(), pattern)) {
      results.push(relative(root, fullPath))
    }
  }
}

function matchGlob(name: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  )
  return regex.test(name)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
