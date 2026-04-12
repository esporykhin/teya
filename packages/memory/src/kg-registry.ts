/**
 * @description Per-identity KnowledgeGraph registry.
 *
 * Each identity scope (owner, guest-tg-789, etc) gets its own knowledge.db
 * file. The registry caches open KnowledgeGraph instances so a single scope
 * is shared across calls within one process, but different scopes never
 * touch each other's data — isolation is at the filesystem level, not
 * via WHERE clauses.
 *
 * Layout:
 *   ~/.teya/memory/knowledge.db                           ← owner (legacy path)
 *   ~/.teya/guests/guest-telegram-789/memory/knowledge.db ← per-guest
 *
 * The owner path stays at the legacy location so existing memories don't
 * need migration.
 */
import { join, dirname } from 'path'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { KnowledgeGraph } from './knowledge.js'
import type { EmbeddingProvider } from './embeddings.js'

const TEYA_HOME = join(homedir(), '.teya')
const OWNER_KG_PATH = join(TEYA_HOME, 'memory', 'knowledge.db')
const GUESTS_ROOT = join(TEYA_HOME, 'guests')

function pathForScope(scopeId: string): string {
  if (scopeId === 'owner') return OWNER_KG_PATH
  return join(GUESTS_ROOT, scopeId, 'memory', 'knowledge.db')
}

export class KnowledgeGraphRegistry {
  private cache = new Map<string, KnowledgeGraph>()
  private embeddingProvider?: EmbeddingProvider

  constructor(embeddingProvider?: EmbeddingProvider) {
    this.embeddingProvider = embeddingProvider
  }

  /** Get or open the KG for the given scope. Creates the directory and DB on first call. */
  for(scopeId: string): KnowledgeGraph {
    const cached = this.cache.get(scopeId)
    if (cached) return cached
    const path = pathForScope(scopeId)
    mkdirSync(dirname(path), { recursive: true })
    const kg = new KnowledgeGraph(path, this.embeddingProvider)
    this.cache.set(scopeId, kg)
    return kg
  }

  /** True if a scope already has memory persisted on disk. */
  has(scopeId: string): boolean {
    return this.cache.has(scopeId)
  }

  /** Close all cached KG instances. Used by process shutdown. */
  closeAll(): void {
    for (const kg of this.cache.values()) {
      try { kg.close() } catch {}
    }
    this.cache.clear()
  }
}
