/**
 * @description Agent workspace — sandboxed directory for all file operations.
 *
 * Default: ~/.teya/workspace/
 * Structure:
 *   ~/.teya/workspace/
 *   ├── drafts/      — work-in-progress files (articles, prompts, configs)
 *   ├── output/      — final deliverables (reports, generated files)
 *   ├── data/        — downloaded/scraped data, CSVs, JSONs
 *   └── temp/        — ephemeral files (auto-cleaned on session start)
 *
 * All file tools resolve relative paths from workspace root.
 * Absolute paths outside workspace are blocked unless allowExternalPaths is true.
 */
import { resolve, relative, isAbsolute } from 'path'
import { mkdir } from 'fs/promises'
import { join } from 'path'

const DEFAULT_WORKSPACE = join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.teya',
  'workspace',
)

const WORKSPACE_DIRS = ['drafts', 'output', 'data', 'temp']

export interface WorkspaceConfig {
  /** Workspace root path. Default: ~/.teya/workspace/ */
  root?: string
  /** Allow read/write to paths outside workspace. Default: false */
  allowExternalReads?: boolean
  /** Allow writes outside workspace. Default: false */
  allowExternalWrites?: boolean
}

let workspaceRoot = DEFAULT_WORKSPACE
let allowExternalReads = false
let allowExternalWrites = false

/**
 * Initialize workspace — create directory structure if needed.
 * Call once at startup.
 */
export async function initWorkspace(config?: WorkspaceConfig): Promise<string> {
  workspaceRoot = config?.root || DEFAULT_WORKSPACE
  allowExternalReads = config?.allowExternalReads ?? false
  allowExternalWrites = config?.allowExternalWrites ?? false

  // Create workspace structure
  await mkdir(workspaceRoot, { recursive: true })
  for (const dir of WORKSPACE_DIRS) {
    await mkdir(join(workspaceRoot, dir), { recursive: true })
  }

  return workspaceRoot
}

/** Get current workspace root */
export function getWorkspaceRoot(): string {
  return workspaceRoot
}

/**
 * Resolve a path relative to workspace. Returns absolute path.
 * Throws if path escapes workspace and external access is not allowed.
 */
export function resolveWorkspacePath(inputPath: string, mode: 'read' | 'write'): string {
  // If absolute path — check if it's inside workspace
  if (isAbsolute(inputPath)) {
    const rel = relative(workspaceRoot, inputPath)
    const isInside = !rel.startsWith('..') && !isAbsolute(rel)

    if (isInside) return inputPath

    // External path
    if (mode === 'read' && allowExternalReads) return inputPath
    if (mode === 'write' && allowExternalWrites) return inputPath

    throw new Error(
      `Path "${inputPath}" is outside workspace. ` +
      `Use a relative path (resolved from ${workspaceRoot}) or prefix with workspace subdirectory: drafts/, output/, data/, temp/`
    )
  }

  // Relative path — resolve from workspace root
  const resolved = resolve(workspaceRoot, inputPath)

  // Double-check it didn't escape via ../
  const rel = relative(workspaceRoot, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${inputPath}" escapes workspace via "../". Use paths within: ${WORKSPACE_DIRS.join(', ')}`)
  }

  return resolved
}

/**
 * Get workspace info string for system prompt injection.
 */
export function getWorkspaceInfo(): string {
  return `## Workspace

Your workspace directory: ${workspaceRoot}
Structure:
- drafts/   — work-in-progress files (articles, prompts, configs)
- output/   — final deliverables (reports, generated files)
- data/     — downloaded/scraped data, CSVs, JSONs
- temp/     — ephemeral files (cleaned between sessions)

When using core:write_file or core:read_file, paths are relative to workspace.
Examples: "drafts/article.md", "output/report.json", "data/prices.csv"
Do NOT write files to the user's home directory or other system paths.`
}
