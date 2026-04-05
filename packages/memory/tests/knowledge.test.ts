import { describe, it, expect, afterEach } from 'vitest'
import { KnowledgeGraph } from '../src/knowledge.js'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

describe('Knowledge Graph', () => {
  let kg: KnowledgeGraph
  let tmpDir: string

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), 'teya-test-'))
    kg = new KnowledgeGraph(join(tmpDir, 'test.db'))
  }

  afterEach(() => {
    kg?.close()
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should add and retrieve entities', () => {
    setup()
    const id = kg.addEntity('Evgeny', 'person', 'Developer')
    expect(id).toBeGreaterThan(0)

    const entity = kg.getEntity('Evgeny')
    expect(entity).toBeDefined()
    expect(entity?.type).toBe('person')
  })

  it('should deduplicate entities', () => {
    setup()
    const id1 = kg.addEntity('Evgeny', 'person')
    const id2 = kg.addEntity('Evgeny', 'person')
    expect(id1).toBe(id2)
  })

  it('should add facts and deduplicate similar ones', async () => {
    setup()
    const entityId = kg.addEntity('Evgeny', 'person')
    const fact1 = await kg.addFact(entityId, 'builds AI products')
    const fact2 = await kg.addFact(entityId, 'builds AI products')  // exact same
    expect(fact1).toBe(fact2)  // deduped
  })

  it('should search facts', async () => {
    setup()
    const entityId = kg.addEntity('Evgeny', 'person')
    await kg.addFact(entityId, 'prefers TypeScript over Python')
    await kg.addFact(entityId, 'lives in Russia')

    const results = await kg.search('TypeScript')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].fact.content).toContain('TypeScript')
  })

  it('should add relations', () => {
    setup()
    const evgenyId = kg.addEntity('Evgeny', 'person')
    const mpstatsId = kg.addEntity('MPSTATS', 'company')
    kg.addRelation(evgenyId, mpstatsId, 'works_at')

    const related = kg.getRelated(evgenyId)
    expect(related.length).toBe(1)
    expect(related[0].entity.name).toBe('MPSTATS')
    expect(related[0].relation).toBe('works_at')
  })
})
