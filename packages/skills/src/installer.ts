/**
 * @description Install skills from GitHub, URL, or local path
 */
import { execSync } from 'child_process'
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync } from 'fs'
import { join, basename } from 'path'

const SKILLS_DIR = join(process.env.HOME || '.', '.teya', 'skills')

export async function installSkill(source: string): Promise<{ name: string; path: string }> {
  mkdirSync(SKILLS_DIR, { recursive: true })

  // GitHub: teya skill add github:user/repo
  // or: teya skill add github:user/repo/path/to/skill
  if (source.startsWith('github:')) {
    return installFromGitHub(source.slice('github:'.length))
  }

  // Full GitHub URL: teya skill add https://github.com/user/repo/tree/main/skill-name
  if (source.includes('github.com')) {
    return installFromGitHubUrl(source)
  }

  // Local path: teya skill add /path/to/skill
  if (existsSync(source)) {
    return installFromLocal(source)
  }

  throw new Error(`Unknown skill source: ${source}. Use github:user/repo, GitHub URL, or local path.`)
}

async function installFromGitHub(spec: string): Promise<{ name: string; path: string }> {
  // spec: "user/repo" or "user/repo/path/to/skill"
  const parts = spec.split('/')
  if (parts.length < 2) throw new Error('GitHub format: github:user/repo or github:user/repo/path')

  const user = parts[0]
  const repo = parts[1]
  const subPath = parts.slice(2).join('/')

  // Clone to temp dir
  const tmpDir = join(SKILLS_DIR, '.tmp-' + Date.now())
  try {
    execSync(`git clone --depth 1 https://github.com/${user}/${repo}.git "${tmpDir}"`, { stdio: 'pipe' })

    const sourceDir = subPath ? join(tmpDir, subPath) : tmpDir

    if (!existsSync(join(sourceDir, 'SKILL.md'))) {
      // Maybe the repo contains multiple skills — list them
      const entries = readdirSync(sourceDir, { withFileTypes: true })
      const skillDirs = entries.filter(e => e.isDirectory() && existsSync(join(sourceDir, e.name, 'SKILL.md')))

      if (skillDirs.length > 0) {
        // Install all skills from repo
        const installed: string[] = []
        for (const dir of skillDirs) {
          const skillName = dir.name
          const targetDir = join(SKILLS_DIR, skillName)
          if (existsSync(targetDir)) rmSync(targetDir, { recursive: true })
          cpSync(join(sourceDir, skillName), targetDir, { recursive: true })
          installed.push(skillName)
        }
        return { name: installed.join(', '), path: SKILLS_DIR }
      }

      throw new Error(`No SKILL.md found in ${spec}`)
    }

    // Single skill
    const skillName = subPath ? basename(subPath) : repo
    const targetDir = join(SKILLS_DIR, skillName)
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true })
    cpSync(sourceDir, targetDir, { recursive: true })

    // Clean up .git if we copied the whole repo
    const gitDir = join(targetDir, '.git')
    if (existsSync(gitDir)) rmSync(gitDir, { recursive: true })

    return { name: skillName, path: targetDir }
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function installFromGitHubUrl(url: string): Promise<{ name: string; path: string }> {
  // Parse: https://github.com/user/repo/tree/main/path/to/skill
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/[^/]+\/(.+))?/)
  if (!match) throw new Error(`Cannot parse GitHub URL: ${url}`)

  const user = match[1]
  const repo = match[2]
  const subPath = match[3] || ''

  return installFromGitHub(`${user}/${repo}${subPath ? '/' + subPath : ''}`)
}

async function installFromLocal(source: string): Promise<{ name: string; path: string }> {
  if (!existsSync(join(source, 'SKILL.md'))) {
    throw new Error(`No SKILL.md found in ${source}`)
  }

  const skillName = basename(source)
  const targetDir = join(SKILLS_DIR, skillName)
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true })
  cpSync(source, targetDir, { recursive: true })

  return { name: skillName, path: targetDir }
}

export function listInstalledSkills(): Array<{ name: string; path: string }> {
  mkdirSync(SKILLS_DIR, { recursive: true })
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => ({ name: e.name, path: join(SKILLS_DIR, e.name) }))
}

export function removeSkill(name: string): boolean {
  const targetDir = join(SKILLS_DIR, name)
  if (!existsSync(targetDir)) return false
  rmSync(targetDir, { recursive: true })
  return true
}
