/**
 * @description Load skills from directory, parse SKILL.md frontmatter, match triggers
 */
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

export interface Skill {
  name: string
  description: string
  triggers: string[]
  body: string
  dir: string
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
      // Handle YAML arrays like: triggers: ["book", "reserve"]
      if (typeof value === 'string' && value.startsWith('[')) {
        try { value = JSON.parse(value.replace(/'/g, '"')) } catch { /* keep as string */ }
      }
      fm[key] = value
    }
  }
  return { frontmatter: fm, body: match[2].trim() }
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
          triggers: Array.isArray(frontmatter.triggers) ? frontmatter.triggers as string[] : [],
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
  const lines = skills.map(s => `- **${s.name}**: ${s.description}`)
  return `## Available Skills\n${lines.join('\n')}`
}

// Build active skill content (only triggered skills)
export function buildActiveSkillContent(activeSkills: Skill[]): string {
  if (activeSkills.length === 0) return ''
  return activeSkills.map(s => `## Skill: ${s.name}\n${s.body}`).join('\n\n')
}

