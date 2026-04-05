/**
 * @description Session intelligence — auto-summary and knowledge extraction.
 *
 * Two processes:
 * 1. summarizeSession() — called after session ends, generates summary + topics
 * 2. extractDailyKnowledge() — daily cron, extracts entities/facts from all sessions
 *
 * Both use a cheap LLM (passed as a function) to minimize costs.
 */
import type { SessionState, Message } from '@teya/core'
import type { KnowledgeGraph } from './knowledge.js'
import type { SessionStore } from './sessions.js'

/** Simple LLM call interface — caller provides the implementation */
export type LLMCall = (systemPrompt: string, userMessage: string) => Promise<string>

// ── Auto-Summary ─────────────────────────────────────────────────────────────

const SUMMARY_PROMPT = `You are a session summarizer. Given a conversation between a user and an AI agent, produce:

1. A summary (3-5 sentences) describing what was discussed and accomplished.
2. A list of topics (3-8 short tags, in the language of the conversation).

Respond ONLY in this JSON format:
{"summary": "...", "topics": ["topic1", "topic2", ...]}

Focus on: what the user wanted, what was done, key decisions, outcomes.
Skip greetings, filler, tool call details.`

/**
 * Generate summary + topics for a session.
 * Call after session ends or when session has enough messages.
 */
export async function summarizeSession(
  session: SessionState,
  llm: LLMCall,
): Promise<{ summary: string; topics: string[] }> {
  // Compress messages to essential content (skip tool results, keep user/assistant)
  const condensed = condenseMessages(session.messages, 4000)

  const context = [
    `Session ID: ${session.id}`,
    `Agent: ${session.agentId}`,
    session.toolsUsed.length > 0 ? `Tools used: ${session.toolsUsed.join(', ')}` : '',
    session.agentsUsed.length > 0 ? `Sub-agents: ${session.agentsUsed.join(', ')}` : '',
    session.taskIds.length > 0 ? `Tasks: ${session.taskIds.join(', ')}` : '',
    `Turns: ${session.totalTurns}`,
    '',
    'Conversation:',
    condensed,
  ].filter(Boolean).join('\n')

  const response = await llm(SUMMARY_PROMPT, context)

  try {
    // Try to parse JSON response
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        summary: parsed.summary || response.slice(0, 500),
        topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 10) : [],
      }
    }
  } catch {
    // Fallback: use response as summary
  }

  return { summary: response.slice(0, 500), topics: [] }
}

/**
 * Process unsummarized sessions in batch.
 * Call from daemon or CLI on idle.
 */
export async function batchSummarize(
  sessionStore: SessionStore,
  llm: LLMCall,
  limit = 5,
): Promise<number> {
  const unsummarized = sessionStore.getUnsummarized(limit)
  let count = 0

  for (const meta of unsummarized) {
    const session = await sessionStore.load(meta.id)
    if (!session || session.messages.length < 3) continue

    try {
      const { summary, topics } = await summarizeSession(session, llm)
      sessionStore.updateSummary(session.id, summary, topics)
      count++
    } catch {
      // Skip failed summarizations
    }
  }

  return count
}

// ── Daily Knowledge Extraction ───────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a knowledge extraction system. Analyze the user's conversations from today and extract structured knowledge.

Extract these types of information:
1. **User preferences** — how they like to work, what tools they prefer, communication style
2. **Project facts** — decisions made, architecture choices, technologies used
3. **People/entities** — projects, tools, services, people mentioned
4. **Patterns** — recurring themes, common requests, workflow habits
5. **Decisions** — important choices made and their reasoning

Respond ONLY in this JSON format:
{
  "entities": [
    {"name": "entity name", "type": "person|project|tool|service|concept", "description": "brief description"}
  ],
  "facts": [
    {"entity": "entity name", "content": "the fact or observation", "tags": ["tag1", "tag2"]}
  ],
  "relations": [
    {"from": "entity A", "to": "entity B", "type": "uses|works_on|prefers|decided|created"}
  ]
}

Rules:
- Extract only NON-OBVIOUS information (don't state that "user uses a computer")
- Facts should be specific and actionable
- Use the language of the conversations
- Focus on things useful for future interactions
- Deduplicate — if same fact appears in multiple sessions, mention once
- Max 20 entities, 30 facts, 15 relations per extraction`

/**
 * Extract knowledge from today's sessions and write to knowledge graph.
 * Designed to run as a daily cron in the scheduler daemon.
 */
export async function extractDailyKnowledge(
  sessionStore: SessionStore,
  kg: KnowledgeGraph,
  llm: LLMCall,
  date?: string,
): Promise<{ entities: number; facts: number; relations: number }> {
  const targetDate = date || new Date().toISOString().slice(0, 10)
  const sessions = await sessionStore.getSessionsForDate(targetDate)

  if (sessions.length === 0) return { entities: 0, facts: 0, relations: 0 }

  // Build a condensed view of all sessions
  const sessionSummaries = sessions.map((s, i) => {
    const condensed = condenseMessages(s.messages, 2000)
    return [
      `--- Session ${i + 1} (${s.id.slice(0, 8)}) ---`,
      s.summary ? `Summary: ${s.summary}` : '',
      s.toolsUsed.length > 0 ? `Tools: ${s.toolsUsed.join(', ')}` : '',
      s.agentsUsed.length > 0 ? `Agents: ${s.agentsUsed.join(', ')}` : '',
      condensed,
    ].filter(Boolean).join('\n')
  }).join('\n\n')

  // Cap total input
  const input = sessionSummaries.slice(0, 15000)

  const response = await llm(EXTRACTION_PROMPT, `Date: ${targetDate}\n\n${input}`)

  // Parse extraction result
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { entities: 0, facts: 0, relations: 0 }

    const parsed = JSON.parse(jsonMatch[0])
    let entityCount = 0, factCount = 0, relationCount = 0

    // Create entities
    const entityMap = new Map<string, number>()
    for (const e of parsed.entities || []) {
      if (!e.name || !e.type) continue
      const id = kg.addEntity(e.name, e.type, e.description || '')
      entityMap.set(e.name, id)
      entityCount++
    }

    // Add facts
    for (const f of parsed.facts || []) {
      if (!f.entity || !f.content) continue
      let entityId = entityMap.get(f.entity)
      if (!entityId) {
        // Create entity on the fly
        entityId = kg.addEntity(f.entity, 'generic', '')
        entityMap.set(f.entity, entityId)
      }
      await kg.addFact(entityId, f.content, f.tags || [], `extraction:${targetDate}`)
      factCount++
    }

    // Add relations
    for (const r of parsed.relations || []) {
      if (!r.from || !r.to || !r.type) continue
      const fromId = entityMap.get(r.from)
      const toId = entityMap.get(r.to)
      if (fromId && toId) {
        kg.addRelation(fromId, toId, r.type)
        relationCount++
      }
    }

    return { entities: entityCount, facts: factCount, relations: relationCount }
  } catch {
    return { entities: 0, facts: 0, relations: 0 }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Condense messages to fit within a token budget (rough char-based) */
function condenseMessages(messages: Message[], maxChars: number): string {
  const lines: string[] = []
  let totalChars = 0

  for (const msg of messages) {
    if (msg.role === 'tool') continue // Skip tool results (noisy)
    if (!msg.content) continue

    const prefix = msg.role === 'user' ? 'User' : 'Agent'
    const content = msg.content.slice(0, 500)
    const line = `${prefix}: ${content}`

    if (totalChars + line.length > maxChars) break
    lines.push(line)
    totalChars += line.length
  }

  return lines.join('\n')
}
