/**
 * @description Load skills from directory, parse SKILL.md frontmatter, match triggers
 */
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

export interface Skill {
  name: string
  description: string
  triggers: string[]
  tags: string[]
  category?: string
  audience?: string
  domains: string[]
  inputs: string[]
  outputs: string[]
  order: number
  body: string
  dir: string
}

function parseScalar(raw: string): unknown {
  const value = raw.trim()
  if (!value) return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
    return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

function parseArray(raw: string): unknown {
  const normalized = raw.replace(/'/g, '"')
  try {
    return JSON.parse(normalized)
  } catch {
    const inner = raw.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map(item => String(parseScalar(item.trim())))
  }
}

// Parse YAML-like frontmatter from SKILL.md
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }

  const fm: Record<string, unknown> = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      let value: unknown = line.slice(colonIdx + 1).trim()
      if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
        value = parseArray(value)
      } else if (typeof value === 'string') {
        value = parseScalar(value)
      }
      fm[key] = value
    }
  }
  return { frontmatter: fm, body: match[2].trim() }
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export async function loadSkills(skillsDir: string): Promise<Skill[]> {
  const skills: Skill[] = []

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillDir = join(skillsDir, entry.name)
      const skillMdPath = join(skillDir, 'SKILL.md')

      try {
        const content = await readFile(skillMdPath, 'utf-8')
        const { frontmatter, body } = parseFrontmatter(content)

        const skill: Skill = {
          name: typeof frontmatter.name === 'string' ? frontmatter.name : entry.name,
          description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
          triggers: toStringArray(frontmatter.triggers),
          tags: toStringArray(frontmatter.tags),
          category: typeof frontmatter.category === 'string' ? frontmatter.category : undefined,
          audience: typeof frontmatter.audience === 'string' ? frontmatter.audience : undefined,
          domains: toStringArray(frontmatter.domains),
          inputs: toStringArray(frontmatter.inputs),
          outputs: toStringArray(frontmatter.outputs),
          order: typeof frontmatter.order === 'number' ? frontmatter.order : 1000,
          body,
          dir: skillDir,
        }

        skills.push(skill)
      } catch {
        // No SKILL.md — skip
      }
    }
  } catch {
    // Skills dir doesn't exist — ok
  }

  return skills
}

// Check if a user message should trigger a skill
export function matchSkills(message: string, skills: Skill[]): Skill[] {
  const lower = message.toLowerCase()
  return skills.filter(skill => {
    // Check explicit triggers
    if (skill.triggers.some(t => lower.includes(t.toLowerCase()))) return true
    // Check description keywords (simple word overlap)
    const descWords = skill.description.toLowerCase().split(/\s+/)
    const msgWords = lower.split(/\s+/)
    const overlap = descWords.filter(w => w.length > 3 && msgWords.includes(w))
    return overlap.length >= 2
  })
}

// Build metadata string for system prompt (always in context)
export function buildSkillsMetadata(skills: Skill[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((s) => {
    const suffix: string[] = []
    if (s.category) suffix.push(`category: ${s.category}`)
    if (s.audience) suffix.push(`audience: ${s.audience}`)
    if (s.domains.length > 0) suffix.push(`domains: ${s.domains.join(', ')}`)
    if (s.tags.length > 0) suffix.push(`tags: ${s.tags.join(', ')}`)
    return `- **${s.name}**: ${s.description}${suffix.length > 0 ? ` (${suffix.join(' | ')})` : ''}`
  })
  return `## Available Skills\n${lines.join('\n')}`
}

// Build active skill content (only triggered skills)
export function buildActiveSkillContent(activeSkills: Skill[]): string {
  if (activeSkills.length === 0) return ''
  return activeSkills.map(s => `## Skill: ${s.name}\n${s.body}`).join('\n\n')
}
