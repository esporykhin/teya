/**
 * @description Knowledge graph — entities, facts, relations with dedup and hybrid search
 */
import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { mkdirSync } from 'fs'
import { cosineSimilarity } from './embeddings.js'
import type { EmbeddingProvider } from './embeddings.js'

export interface Entity {
  id: number
  name: string
  type: string
  description: string
  created_at: string
}

export interface Fact {
  id: number
  entity_id: number
  content: string
  tags: string[]
  source: string
  created_at: string
  accessed_at: string
  superseded_by: number | null
}

export interface Relation {
  id: number
  from_entity_id: number
  to_entity_id: number
  relation_type: string
  created_at: string
}

export class KnowledgeGraph {
  private db: Database.Database
  private embeddingProvider?: EmbeddingProvider

  constructor(dbPath?: string, embeddingProvider?: EmbeddingProvider) {
    const dir = dbPath
      ? dirname(dbPath)
      : join(process.env.HOME || process.env.USERPROFILE || '.', '.teya', 'memory')
    mkdirSync(dir, { recursive: true })

    const fullPath = dbPath || join(dir, 'knowledge.db')
    this.db = new Database(fullPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.embeddingProvider = embeddingProvider
    this.initTables()
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'generic',
        description TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_type ON entities(name, type);

      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '[]',
        source TEXT DEFAULT 'agent',
        created_at TEXT DEFAULT (datetime('now')),
        accessed_at TEXT DEFAULT (datetime('now')),
        superseded_by INTEGER REFERENCES facts(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id);
      CREATE INDEX IF NOT EXISTS idx_facts_content ON facts(content);

      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        to_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
      CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);
    `)

    // Add embedding column if not present (migration for existing DBs)
    try {
      this.db.exec('ALTER TABLE facts ADD COLUMN embedding BLOB')
    } catch {
      // Column already exists
    }
  }

  // --- Entities ---

  addEntity(name: string, type: string = 'generic', description: string = ''): number {
    const existing = this.db
      .prepare('SELECT id FROM entities WHERE name = ? AND type = ?')
      .get(name, type) as { id: number } | undefined
    if (existing) return existing.id

    const result = this.db
      .prepare('INSERT INTO entities (name, type, description) VALUES (?, ?, ?)')
      .run(name, type, description)
    return result.lastInsertRowid as number
  }

  getEntity(name: string): Entity | undefined {
    return this.db
      .prepare('SELECT * FROM entities WHERE name = ?')
      .get(name) as Entity | undefined
  }

  listEntities(type?: string): Entity[] {
    if (type) {
      return this.db
        .prepare('SELECT * FROM entities WHERE type = ? ORDER BY created_at DESC')
        .all(type) as Entity[]
    }
    return this.db
      .prepare('SELECT * FROM entities ORDER BY created_at DESC')
      .all() as Entity[]
  }

  // --- Facts ---

  async addFact(entityId: number, content: string, tags: string[] = [], source: string = 'agent'): Promise<number> {
    const existing = this.db
      .prepare('SELECT id, content, embedding FROM facts WHERE entity_id = ? AND superseded_by IS NULL')
      .all(entityId) as { id: number; content: string; embedding: Buffer | null }[]

    for (const fact of existing) {
      const similar = await this.isSimilarAsync(content, fact.content, 0.8, null, fact.embedding)
      if (similar) {
        this.db
          .prepare("UPDATE facts SET accessed_at = datetime('now') WHERE id = ?")
          .run(fact.id)
        return fact.id
      }
    }

    const result = this.db
      .prepare('INSERT INTO facts (entity_id, content, tags, source) VALUES (?, ?, ?, ?)')
      .run(entityId, content, JSON.stringify(tags), source)
    const factId = result.lastInsertRowid as number

    if (this.embeddingProvider) {
      try {
        const embedding = await this.embeddingProvider.embed(content)
        const buf = Buffer.from(new Float32Array(embedding).buffer)
        this.db.prepare('UPDATE facts SET embedding = ? WHERE id = ?').run(buf, factId)
      } catch {
        // Embedding failed — continue without it
      }
    }

    return factId
  }

  async supersedeFact(oldFactId: number, newContent: string, tags: string[] = [], source: string = 'agent'): Promise<number> {
    const oldFact = this.db
      .prepare('SELECT entity_id FROM facts WHERE id = ?')
      .get(oldFactId) as { entity_id: number } | undefined
    if (!oldFact) throw new Error(`Fact ${oldFactId} not found`)

    const newId = this.db
      .prepare('INSERT INTO facts (entity_id, content, tags, source) VALUES (?, ?, ?, ?)')
      .run(oldFact.entity_id, newContent, JSON.stringify(tags), source)
      .lastInsertRowid as number

    this.db
      .prepare('UPDATE facts SET superseded_by = ? WHERE id = ?')
      .run(newId, oldFactId)

    if (this.embeddingProvider) {
      try {
        const embedding = await this.embeddingProvider.embed(newContent)
        const buf = Buffer.from(new Float32Array(embedding).buffer)
        this.db.prepare('UPDATE facts SET embedding = ? WHERE id = ?').run(buf, newId)
      } catch {
        // Embedding failed — continue without it
      }
    }

    return newId
  }

  getEntityFacts(entityId: number): Fact[] {
    const rows = this.db
      .prepare('SELECT * FROM facts WHERE entity_id = ? AND superseded_by IS NULL ORDER BY accessed_at DESC')
      .all(entityId) as Record<string, unknown>[]
    return rows.map(r => ({ ...r, tags: JSON.parse(r.tags as string) }) as Fact)
  }

  // --- Relations ---

  addRelation(fromEntityId: number, toEntityId: number, relationType: string): number {
    const existing = this.db
      .prepare('SELECT id FROM relations WHERE from_entity_id = ? AND to_entity_id = ? AND relation_type = ?')
      .get(fromEntityId, toEntityId, relationType) as { id: number } | undefined
    if (existing) return existing.id

    const result = this.db
      .prepare('INSERT INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)')
      .run(fromEntityId, toEntityId, relationType)
    return result.lastInsertRowid as number
  }

  getRelated(entityId: number): Array<{ entity: Entity; relation: string; direction: 'from' | 'to' }> {
    const results: Array<{ entity: Entity; relation: string; direction: 'from' | 'to' }> = []

    const outgoing = this.db
      .prepare(`
        SELECT e.*, r.relation_type FROM relations r
        JOIN entities e ON e.id = r.to_entity_id
        WHERE r.from_entity_id = ?
      `)
      .all(entityId) as (Entity & { relation_type: string })[]
    for (const row of outgoing) {
      results.push({ entity: row, relation: row.relation_type, direction: 'from' })
    }

    const incoming = this.db
      .prepare(`
        SELECT e.*, r.relation_type FROM relations r
        JOIN entities e ON e.id = r.from_entity_id
        WHERE r.to_entity_id = ?
      `)
      .all(entityId) as (Entity & { relation_type: string })[]
    for (const row of incoming) {
      results.push({ entity: row, relation: row.relation_type, direction: 'to' })
    }

    return results
  }

  // --- Search ---

  async search(query: string, limit: number = 10): Promise<Array<{ fact: Fact; entity: Entity }>> {
    // Keyword search
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    const keywordResults: Array<{ fact: Fact; entity: Entity }> = []

    if (words.length > 0) {
      const conditions = words.map(() => 'LOWER(f.content) LIKE ?').join(' OR ')
      const params: unknown[] = words.map(w => `%${w}%`)

      const rows = this.db
        .prepare(`
          SELECT f.*, e.name as entity_name, e.type as entity_type,
                 e.description as entity_description, e.created_at as entity_created_at
          FROM facts f
          JOIN entities e ON e.id = f.entity_id
          WHERE f.superseded_by IS NULL AND (${conditions})
          ORDER BY f.accessed_at DESC
          LIMIT ?
        `)
        .all(...params, limit) as Record<string, unknown>[]

      for (const row of rows) {
        this.db
          .prepare("UPDATE facts SET accessed_at = datetime('now') WHERE id = ?")
          .run(row.id)
      }

      keywordResults.push(...rows.map(r => ({
        fact: {
          id: r.id,
          entity_id: r.entity_id,
          content: r.content,
          tags: JSON.parse(r.tags as string),
          source: r.source,
          created_at: r.created_at,
          accessed_at: r.accessed_at,
          superseded_by: r.superseded_by,
        } as Fact,
        entity: {
          id: r.entity_id,
          name: r.entity_name,
          type: r.entity_type,
          description: r.entity_description,
          created_at: r.entity_created_at,
        } as Entity,
      })))
    }

    // Semantic search
    const semanticResults = await this.semanticSearch(query, limit)

    // Merge: deduplicate by fact id, keyword results first
    const seen = new Set<number>()
    const merged: Array<{ fact: Fact; entity: Entity }> = []

    for (const r of keywordResults) {
      if (!seen.has(r.fact.id)) {
        seen.add(r.fact.id)
        merged.push(r)
      }
    }
    for (const r of semanticResults) {
      if (!seen.has(r.fact.id)) {
        seen.add(r.fact.id)
        merged.push({ fact: r.fact, entity: r.entity })
      }
    }

    return merged.slice(0, limit)
  }

  async semanticSearch(query: string, limit: number = 10): Promise<Array<{ fact: Fact; entity: Entity; score: number }>> {
    if (!this.embeddingProvider) return []

    let queryEmbedding: number[]
    try {
      queryEmbedding = await this.embeddingProvider.embed(query)
    } catch {
      return []
    }

    const rows = this.db
      .prepare(`
        SELECT f.*, e.name as entity_name, e.type as entity_type,
               e.description as entity_description, e.created_at as entity_created_at
        FROM facts f
        JOIN entities e ON e.id = f.entity_id
        WHERE f.superseded_by IS NULL AND f.embedding IS NOT NULL
      `)
      .all() as Record<string, unknown>[]

    const scored = rows.map(r => {
      const embBuf = r.embedding as Buffer
      const vec = Array.from(new Float32Array(embBuf.buffer, embBuf.byteOffset, embBuf.byteLength / 4))
      const score = cosineSimilarity(queryEmbedding, vec)
      return { r, score }
    })

    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, limit).map(({ r, score }) => ({
      fact: {
        id: r.id,
        entity_id: r.entity_id,
        content: r.content,
        tags: JSON.parse(r.tags as string),
        source: r.source,
        created_at: r.created_at,
        accessed_at: r.accessed_at,
        superseded_by: r.superseded_by,
      } as Fact,
      entity: {
        id: r.entity_id,
        name: r.entity_name,
        type: r.entity_type,
        description: r.entity_description,
        created_at: r.entity_created_at,
      } as Entity,
      score,
    }))
  }

  // --- Helpers ---

  private isSimilar(a: string, b: string, threshold: number): boolean {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2))
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2))
    if (wordsA.size === 0 || wordsB.size === 0) return false

    let overlap = 0
    for (const w of wordsA) {
      if (wordsB.has(w)) overlap++
    }

    const similarity = overlap / Math.max(wordsA.size, wordsB.size)
    return similarity >= threshold
  }

  private async isSimilarAsync(
    a: string,
    b: string,
    threshold: number,
    _embeddingA: Buffer | null,
    embeddingB: Buffer | null,
  ): Promise<boolean> {
    // If we have an embedding for B and a provider, compute A's embedding and compare
    if (embeddingB && this.embeddingProvider) {
      try {
        const vecA = await this.embeddingProvider.embed(a)
        const vecB = Array.from(new Float32Array(embeddingB.buffer, embeddingB.byteOffset, embeddingB.byteLength / 4))
        return cosineSimilarity(vecA, vecB) >= 0.85
      } catch {
        // Fall through to word overlap
      }
    }
    return this.isSimilar(a, b, threshold)
  }

  close(): void {
    this.db.close()
  }
}
