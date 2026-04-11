import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('verified skills', () => {
  const originalHome = process.env.HOME
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'teya-skills-test-'))
    process.env.HOME = tmpHome
  })

  afterEach(() => {
    process.env.HOME = originalHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('lists verified skills from the repository catalog', async () => {
    const { listVerifiedSkills } = await import('../src/verified.js')
    const skills = await listVerifiedSkills()

    expect(skills[0]?.slug).toBe('digest')
    expect(skills.some(skill => skill.slug === 'market-research')).toBe(true)
    expect(skills.some(skill => skill.slug === 'sales-pipeline' && skill.audience === 'business')).toBe(true)
    expect(skills.some(skill => skill.slug === 'personal-stylist' && skill.category === 'style')).toBe(true)
    expect(skills.some(skill => skill.slug === 'nutrition-coach' && skill.domains.includes('nutrition'))).toBe(true)
    expect(skills.some(skill => skill.slug === 'digest' && skill.category === 'content')).toBe(true)
    expect(skills.some(skill => skill.slug === 'digest' && skill.audience === 'both')).toBe(true)
    expect(skills.some(skill => skill.slug === 'market-research' && skill.domains.includes('strategy'))).toBe(true)
  })

  it('builds a verified skills catalog that recommends verified skills without blocking custom ones', async () => {
    const { buildVerifiedSkillsCatalog } = await import('../src/verified.js')
    const catalog = await buildVerifiedSkillsCatalog()

    expect(catalog).toContain('Verified Skills Available To Install')
    expect(catalog).toContain('teya skill add verified:<name>')
    expect(catalog).toContain('Users can still install custom skills from GitHub, URL, or local path')
    expect(catalog).toContain('## Both Skills')
    expect(catalog).toContain('### Content')
    expect(catalog).toContain('digest')
    expect(catalog).toContain('audience: both')
    expect(catalog).toContain('domains: content, research, operations')
    expect(catalog).toContain('tags: digest, newsletter, sources, tables, content')
    expect(catalog).toContain('market-research')
    expect(catalog).toContain('sales-pipeline')
    expect(catalog).toContain('personal-stylist')
    expect(catalog).toContain('nutrition-coach')
    expect(catalog).toContain('## Personal Skills')
  })

  it('installs a verified skill into ~/.teya/skills', async () => {
    const { installSkill, listInstalledSkills } = await import('../src/index.js')
    const result = await installSkill('verified:digest')

    expect(result.name).toBe('digest')
    expect(existsSync(join(tmpHome, '.teya', 'skills', 'digest', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(tmpHome, '.teya', 'skills', 'digest', 'tables.md'))).toBe(true)
    expect(existsSync(join(tmpHome, '.teya', 'skills', 'digest', 'templates', 'digest-outline.md'))).toBe(true)
    expect(listInstalledSkills().some(skill => skill.name === 'digest')).toBe(true)

    const content = readFileSync(join(tmpHome, '.teya', 'skills', 'digest', 'SKILL.md'), 'utf-8')
    expect(content).toContain('# Digest')
  })

  it('still installs custom local skills outside the verified catalog', async () => {
    const customSource = join(tmpHome, 'custom-skill')
    mkdirSync(customSource, { recursive: true })
    writeFileSync(join(customSource, 'SKILL.md'), [
      '---',
      'name: custom-skill',
      'description: A local custom skill.',
      '---',
      '',
      '# Custom Skill',
    ].join('\n'))

    const { installSkill, listInstalledSkills } = await import('../src/index.js')
    const result = await installSkill(customSource)

    expect(result.name).toBe('custom-skill')
    expect(existsSync(join(tmpHome, '.teya', 'skills', 'custom-skill', 'SKILL.md'))).toBe(true)
    expect(listInstalledSkills().some(skill => skill.name === 'custom-skill')).toBe(true)
  })
})
