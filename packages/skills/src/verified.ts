import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { loadSkills, type Skill } from './loader.js'

export interface VerifiedSkillInfo extends Skill {
  slug: string
  sourceDir: string
}

export function getVerifiedSkillsDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  return join(currentDir, '..', 'verified')
}

export function getVerifiedSkillSourceDir(name: string): string {
  const sourceDir = join(getVerifiedSkillsDir(), name)
  if (!existsSync(join(sourceDir, 'SKILL.md'))) {
    throw new Error(`Verified skill not found: ${name}`)
  }
  return sourceDir
}

export async function listVerifiedSkills(): Promise<VerifiedSkillInfo[]> {
  const verifiedDir = getVerifiedSkillsDir()
  const loaded = await loadSkills(verifiedDir)
  return loaded
    .map(skill => ({
      ...skill,
      slug: basename(skill.dir),
      sourceDir: skill.dir,
    }))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order
      if ((a.audience || '') !== (b.audience || '')) return (a.audience || '').localeCompare(b.audience || '')
      if ((a.category || '') !== (b.category || '')) return (a.category || '').localeCompare(b.category || '')
      return a.slug.localeCompare(b.slug)
    })
}

export async function buildVerifiedSkillsCatalog(): Promise<string> {
  try {
    const skills = await listVerifiedSkills()
    if (skills.length === 0) return ''

    const audienceGroups = new Map<string, Map<string, string[]>>()
    for (const skill of skills) {
      const details: string[] = []
      if (skill.audience) details.push(`audience: ${skill.audience}`)
      if (skill.domains.length > 0) details.push(`domains: ${skill.domains.join(', ')}`)
      if (skill.category) details.push(`category: ${skill.category}`)
      if (skill.tags.length > 0) details.push(`tags: ${skill.tags.join(', ')}`)
      if (skill.inputs.length > 0) details.push(`inputs: ${skill.inputs.join(', ')}`)
      if (skill.outputs.length > 0) details.push(`outputs: ${skill.outputs.join(', ')}`)

      const audience = skill.audience || 'both'
      const category = skill.category || 'general'
      const categoryGroups = audienceGroups.get(audience) || new Map<string, string[]>()
      const bucket = categoryGroups.get(category) || []
      bucket.push(`- **${skill.slug}**: ${skill.description || 'Verified skill'}${details.length > 0 ? ` (${details.join(' | ')})` : ''}`)
      categoryGroups.set(category, bucket)
      audienceGroups.set(audience, categoryGroups)
    }

    const sections = [...audienceGroups.entries()]
      .sort(([a], [b]) => audienceSortKey(a).localeCompare(audienceSortKey(b)))
      .map(([audience, categoryGroups]) => {
        const categorySections = [...categoryGroups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([category, lines]) => `### ${titleCase(category)}\n${lines.join('\n')}`)
        return `## ${titleCase(audience)} Skills\n${categorySections.join('\n\n')}`
      })

    return [
      '## Verified Skills Available To Install',
      'These skills are bundled with Teya as a curated verified catalog. If the user asks for one, install it for them with `teya skill add verified:<name>`.',
      'Users can still install custom skills from GitHub, URL, or local path. Verified skills are the recommended built-in option, not a restriction.',
      '',
      sections.join('\n\n'),
    ].join('\n')
  } catch {
    return ''
  }
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function audienceSortKey(value: string): string {
  if (value === 'business') return '0'
  if (value === 'personal') return '1'
  if (value === 'both') return '2'
  return `3-${value}`
}
