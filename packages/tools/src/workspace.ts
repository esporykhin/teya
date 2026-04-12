/**
 * @description Per-identity sandboxed workspace.
 *
 * Each identity gets its own filesystem area that all file tools resolve
 * against. Owners read/write `~/.teya/workspace/`; guests get isolated
 * sandboxes under `~/.teya/guests/<scopeId>/workspace/`. The active
 * workspace is selected automatically via @teya/core's identity context
 * (AsyncLocalStorage), so leaf tools call `getWorkspaceRoot()` and the
 * right path comes back without any per-call plumbing.
 *
 * Privacy/security:
 *  - A guest's `core:files` write to "drafts/foo.md" lands inside their
 *    OWN sandbox, never inside the owner's workspace.
 *  - `resolveWorkspacePath()` blocks any attempt to escape the active
 *    sandbox via absolute paths or `../`.
 *  - Module-level overrides (initWorkspace) are used only for the
 *    OWNER's default location; per-guest sandboxes are created lazily
 *    on first access.
 */
import { resolve, relative, isAbsolute, join, dirname } from 'path'
import { mkdir } from 'fs/promises'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { getCurrentIdentity } from '@teya/core'

const TEYA_HOME = join(homedir(), '.teya')
const OWNER_WORKSPACE_DEFAULT = join(TEYA_HOME, 'workspace')
const GUESTS_ROOT = join(TEYA_HOME, 'guests')

const WORKSPACE_DIRS = ['drafts', 'output', 'data', 'temp']

export interface WorkspaceConfig {
  /** Owner workspace root path. Default: ~/.teya/workspace/ */
  root?: string
  /** Allow read/write to paths outside workspace. Default: false */
  allowExternalReads?: boolean
  /** Allow writes outside workspace. Default: false */
  allowExternalWrites?: boolean
}

let ownerWorkspace = OWNER_WORKSPACE_DEFAULT
let allowExternalReads = false
let allowExternalWrites = false

/**
 * Initialize the OWNER workspace — create directory structure if needed.
 * Guest workspaces are created on demand via getWorkspaceRoot()/ensureScopeWorkspaceSync().
 *
 * Call once at startup. The external-access flags ONLY apply to owner.
 * Guests are always confined to their own sandbox regardless of flags.
 */
export async function initWorkspace(config?: WorkspaceConfig): Promise<string> {
  ownerWorkspace = config?.root || OWNER_WORKSPACE_DEFAULT
  allowExternalReads = config?.allowExternalReads ?? false
  allowExternalWrites = config?.allowExternalWrites ?? false

  await mkdir(ownerWorkspace, { recursive: true })
  for (const dir of WORKSPACE_DIRS) {
    await mkdir(join(ownerWorkspace, dir), { recursive: true })
  }
  return ownerWorkspace
}

/**
 * Resolve the workspace path for a specific scope id (owner or guest).
 * Pure helper — doesn't depend on the current identity context.
 */
export function workspacePathForScope(scopeId: string): string {
  if (scopeId === 'owner') return ownerWorkspace
  return join(GUESTS_ROOT, scopeId, 'workspace')
}

/**
 * Make sure the directory tree exists for a scope. Synchronous because
 * it's called from getWorkspaceRoot() which has to return a path
 * immediately for downstream tools.
 */
function ensureScopeWorkspaceSync(scopeId: string): string {
  const root = workspacePathForScope(scopeId)
  mkdirSync(root, { recursive: true })
  for (const dir of WORKSPACE_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  return root
}

/**
 * Get the workspace root for the CURRENT identity. If no identity is
 * active (e.g. CLI without identity wiring, or test code), falls back
 * to the owner workspace.
 */
export function getWorkspaceRoot(): string {
  const id = getCurrentIdentity()
  if (!id || id.isOwner) return ownerWorkspace
  return ensureScopeWorkspaceSync(id.scopeId)
}

/**
 * Resolve a path relative to the CURRENT identity's workspace.
 * Throws if the path tries to escape the sandbox via absolute paths
 * or `../` segments.
 *
 * For OWNER identity, the legacy `allowExternalReads` / `allowExternalWrites`
 * config is honoured (owner can opt into reading host files via flags).
 * For GUEST identity, escape is ALWAYS blocked — no opt-out.
 */
export function resolveWorkspacePath(inputPath: string, mode: 'read' | 'write'): string {
  const root = getWorkspaceRoot()
  const id = getCurrentIdentity()
  const isOwner = !id || id.isOwner

  if (isAbsolute(inputPath)) {
    const rel = relative(root, inputPath)
    const isInside = !rel.startsWith('..') && !isAbsolute(rel)

    if (isInside) return inputPath

    // External access only makes sense for owner, and only if the
    // operator opted in via initWorkspace flags.
    if (isOwner) {
      if (mode === 'read' && allowExternalReads) return inputPath
      if (mode === 'write' && allowExternalWrites) return inputPath
    }

    throw new Error(
      `Path "${inputPath}" is outside the active workspace (${root}). ` +
      `Use a relative path or one of: ${WORKSPACE_DIRS.join(', ')}`,
    )
  }

  // Relative path — resolve from active workspace root.
  const resolved = resolve(root, inputPath)
  const rel = relative(root, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${inputPath}" escapes workspace via "../". Use paths within: ${WORKSPACE_DIRS.join(', ')}`)
  }
  return resolved
}

/**
 * System-prompt-friendly workspace description for the CURRENT identity.
 * The model gets a different message depending on who it's talking to.
 */
export function getWorkspaceInfo(): string {
  const root = getWorkspaceRoot()
  const id = getCurrentIdentity()
  const isOwner = !id || id.isOwner

  const header = isOwner
    ? `## Workspace\n\nYour workspace directory: ${root}`
    : `## Workspace\n\nYou are operating in a SANDBOXED workspace for this user: ${root}\nYou cannot read or write outside this directory.`

  return `${header}
Structure:
- drafts/   — work-in-progress files (articles, prompts, configs)
- output/   — final deliverables (reports, generated files)
- data/     — downloaded/scraped data, CSVs, JSONs
- temp/     — ephemeral files (cleaned between sessions)

When using core:files, paths are relative to the workspace root.
Examples: "drafts/article.md", "output/report.json", "data/prices.csv"
Do NOT write files outside this directory.`
}
