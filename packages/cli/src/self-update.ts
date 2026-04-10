/**
 * @description Self-update mechanism — pulls latest code from GitHub, rebuilds.
 * User data (~/.teya/) is never touched — only the code directory is updated.
 */
import { execSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

export interface UpdateResult {
  success: boolean
  repoRoot: string
  beforeRef: string
  afterRef: string
  changes: string[]
  error?: string
  needsRestart: boolean
  entryPoint?: string
}

/**
 * Find the git repo root from the running binary location.
 * Walks up from the CLI package dist/ to the monorepo root.
 */
function findRepoRoot(): string | null {
  // __dirname equivalent for ESM
  const thisFile = fileURLToPath(import.meta.url)
  let dir = dirname(thisFile)

  // Walk up until we find .git
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

/**
 * Get current git short ref
 */
function getRef(cwd: string): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd, encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

/**
 * Run self-update: git pull + pnpm install + pnpm build
 */
export async function selfUpdate(onProgress?: (msg: string) => void): Promise<UpdateResult> {
  const log = onProgress || (() => {})

  const repoRoot = findRepoRoot()
  if (!repoRoot) {
    return {
      success: false,
      repoRoot: '',
      beforeRef: '',
      afterRef: '',
      changes: [],
      error: 'Could not find git repository. Was Teya installed from git?',
      needsRestart: false,
    }
  }

  const beforeRef = getRef(repoRoot)
  log(`Repository: ${repoRoot}`)
  log(`Current version: ${beforeRef}`)

  try {
    // Check for uncommitted changes
    const status = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf-8' }).trim()
    if (status) {
      return {
        success: false,
        repoRoot,
        beforeRef,
        afterRef: beforeRef,
        changes: [],
        error: 'Local changes detected. Stash or commit them first.',
        needsRestart: false,
      }
    }

    // Pull latest
    log('Pulling latest changes...')
    const pullOutput = execSync('git pull --ff-only', { cwd: repoRoot, encoding: 'utf-8' }).trim()

    const afterRef = getRef(repoRoot)

    if (beforeRef === afterRef) {
      log('Already up to date.')
      return {
        success: true,
        repoRoot,
        beforeRef,
        afterRef,
        changes: [],
        needsRestart: false,
      }
    }

    // Get list of changed files
    const diffOutput = execSync(`git log --oneline ${beforeRef}..${afterRef}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).trim()
    const changes = diffOutput ? diffOutput.split('\n') : []

    // Install dependencies (in case new packages were added)
    log('Installing dependencies...')
    execSync('pnpm install --frozen-lockfile', {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 120_000,
    })

    // Rebuild all packages
    log('Building...')
    execSync('pnpm -r build', {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 120_000,
    })

    log(`Updated: ${beforeRef} -> ${afterRef} (${changes.length} commits)`)

    return {
      success: true,
      repoRoot,
      beforeRef,
      afterRef,
      changes,
      needsRestart: true,
      entryPoint: join(repoRoot, 'packages', 'cli', 'dist', 'index.js'),
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      repoRoot,
      beforeRef,
      afterRef: getRef(repoRoot),
      changes: [],
      error: msg,
      needsRestart: false,
    }
  }
}

/**
 * Restart the current process by spawning a new one with the updated code
 * and exiting the current one. The new process inherits stdio so the user
 * sees a seamless transition.
 */
export function restartProcess(entryPoint: string): never {
  const args = process.argv.slice(2).filter(a => a !== 'update')
  const child = spawn(process.execPath, [entryPoint, ...args], {
    stdio: 'inherit',
    detached: true,
  })
  child.unref()
  process.exit(0)
}
