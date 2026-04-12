/**
 * @description core:memory — unified knowledge graph tool.
 *
 * Actions:
 *   read    — search memory by query or entity name
 *   write   — save a fact about an entity
 *   search  — semantic + keyword search
 *   entities — list known entities
 *   relate  — create relation between entities
 *   update  — supersede an old fact with a new one
 *
 * Memory is per-identity. The owner has one knowledge graph; each guest
 * has their own. Selection happens automatically via the identity context
 * carried in AsyncLocalStorage. The tool itself doesn't know about scopes
 * — it just calls registry.for(currentScopeId).
 */
import type { KnowledgeGraph } from './knowledge.js'
import type { KnowledgeGraphRegistry } from './kg-registry.js'
import { getCurrentIdentity } from '@teya/core'

/**
 * Create memory tools backed by either a single KG (legacy / single-tenant)
 * or a per-scope registry (multi-identity / sandbox mode).
 */
export function createMemoryTools(source: KnowledgeGraph | KnowledgeGraphRegistry) {
  // Helper that returns the active KG for the current identity. When called
  // with a singleton KG (legacy callers), always returns that one. When
  // called with a registry, looks up the scope from AsyncLocalStorage.
  function activeKg(): KnowledgeGraph {
    if ('for' in source && typeof source.for === 'function') {
      const id = getCurrentIdentity()
      return source.for(id?.scopeId || 'owner')
    }
    return source as KnowledgeGraph
  }

  return _buildTools(activeKg)
}

function _buildTools(activeKg: () => KnowledgeGraph) {
  const kgProxy = new Proxy({} as KnowledgeGraph, {
    get(_t, prop) {
      const target = activeKg() as unknown as Record<string | symbol, unknown>
      const value = target[prop]
      return typeof value === 'function' ? (value as Function).bind(target) : value
    },
  })
  const kg = kgProxy
  const memoryTool = {
    name: 'core:memory',
    description: `Long-term memory — your persistent knowledge graph.

Actions:
  read     — look up an entity's facts and relations
  write    — save a fact about an entity (auto-dedup)
  search   — find facts by keyword or semantic query
  entities — list all known entities
  relate   — link two entities
  update   — replace an outdated fact

How to write good facts — EVERY fact must be SELF-CONTAINED (understandable without conversation context):

BAD:  entity="Evgeny", fact="Boss, stack, philosophy Tiny Empire"
BAD:  entity="Loocl", fact="uses TypeScript"
GOOD: entity="Evgeny Sporykhin", fact="Solo developer building AI products at MPSTATS and personal projects (Loocl, Qreata)"
GOOD: entity="Loocl", fact="Backend built on FastAPI with PostgreSQL and Redis for BullMQ job queues"

Rules:
1. One fact = one atomic piece of information
2. Fact must include subject and context — readable by any agent 6 months later
3. Never concatenate multiple facts with commas — call write multiple times
4. Use relate to connect entities (Evgeny -> owns -> Loocl)
5. Write in the language the user speaks`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write', 'search', 'entities', 'relate', 'update'],
          description: 'Action to perform',
        },
        // For read/search
        query: { type: 'string', description: 'Search query or entity name (read/search)' },
        // For write
        entity_name: { type: 'string', description: 'Entity name (write/read/relate)' },
        entity_type: { type: 'string', description: 'Entity type: person, project, company, concept, preference (write)' },
        fact: { type: 'string', description: 'A single self-contained fact. Must be understandable without conversation context. Include subject and context.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags (write)' },
        // For relate
        from: { type: 'string', description: 'Source entity name (relate)' },
        to: { type: 'string', description: 'Target entity name (relate)' },
        relation: { type: 'string', description: 'Relation type: uses, works_on, prefers, etc. (relate)' },
        // For update
        fact_id: { type: 'number', description: 'Old fact ID to supersede (update)' },
        // For entities
        type: { type: 'string', description: 'Filter entities by type (entities)' },
      },
      required: ['action'],
    },
    source: 'builtin' as const,
    cost: {
      latency: 'instant' as const,
      tokenCost: 'low' as const,
      sideEffects: false, // read-heavy, write actions have side effects but that's action-dependent
      reversible: true,
      external: false,
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const action = args.action as string

      switch (action) {
        case 'read': {
          const entityName = (args.entity_name || args.query) as string
          if (!entityName) return 'Need entity_name or query for read action.'

          const entity = kg.getEntity(entityName)
          if (!entity) return `No entity found: "${entityName}". Try action=search.`

          const facts = kg.getEntityFacts(entity.id)
          const related = kg.getRelated(entity.id)
          return [
            `${entity.name} (${entity.type})${entity.description ? ': ' + entity.description : ''}`,
            facts.length > 0 ? '\nFacts:' : '',
            ...facts.map(f => `- ${f.content}${f.tags.length ? ` [${f.tags.join(', ')}]` : ''}`),
            related.length > 0 ? '\nRelations:' : '',
            ...related.map(r => `- ${r.direction === 'from' ? '->' : '<-'} ${r.relation} ${r.entity.name}`),
          ].filter(Boolean).join('\n')
        }

        case 'write': {
          const entityName = args.entity_name as string
          if (!entityName) return 'Need entity_name for write action.'
          const fact = args.fact as string
          if (!fact) return 'Need fact for write action.'

          const entityType = (args.entity_type as string) || 'generic'
          const tags = (args.tags as string[]) || []
          const entityId = kg.addEntity(entityName, entityType)
          const factId = await kg.addFact(entityId, fact, tags)
          return `Saved: [${entityName}] ${fact} (fact #${factId})`
        }

        case 'search': {
          const query = args.query as string
          if (!query) return 'Need query for search action.'

          const results = await kg.search(query)
          if (results.length === 0) return 'No relevant facts found.'
          return results.map(r => `[${r.entity.name}] ${r.fact.content}`).join('\n')
        }

        case 'entities': {
          const type = args.type as string | undefined
          const entities = kg.listEntities(type)
          if (entities.length === 0) return type ? `No entities of type "${type}".` : 'Memory is empty.'
          return entities.map(e => {
            const facts = kg.getEntityFacts(e.id)
            return `${e.name} (${e.type}) — ${facts.length} facts`
          }).join('\n')
        }

        case 'relate': {
          const from = args.from as string
          const to = args.to as string
          const rel = args.relation as string
          if (!from || !to || !rel) return 'Need from, to, and relation for relate action.'

          const fromEntity = kg.getEntity(from)
          const toEntity = kg.getEntity(to)
          if (!fromEntity) return `Entity "${from}" not found. Create it first with write.`
          if (!toEntity) return `Entity "${to}" not found. Create it first with write.`

          const relId = kg.addRelation(fromEntity.id, toEntity.id, rel)
          return `Linked: ${from} -[${rel}]-> ${to} (relation #${relId})`
        }

        case 'update': {
          const factId = args.fact_id as number
          const newFact = args.fact as string
          if (!factId || !newFact) return 'Need fact_id and fact for update action.'

          const tags = (args.tags as string[]) || []
          const newId = await kg.supersedeFact(factId, newFact, tags)
          return `Updated: fact #${factId} superseded by #${newId}: ${newFact}`
        }

        default:
          return `Unknown action: ${action}. Use: read, write, search, entities, relate, update`
      }
    },
  }

  // Return both compound tool and legacy names for backward compatibility during transition
  return { memoryTool, memoryRead: memoryTool, memoryWrite: memoryTool }
}
