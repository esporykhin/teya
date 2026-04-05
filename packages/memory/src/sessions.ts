/**
 * @description Session persistence — SQLite index for metadata + JSON files for messages.
 *
 * Architecture:
 * - ~/.teya/sessions.db — lightweight index (id, summary, topics, tools, agents, cost, dates)
 * - ~/.teya/sessions/{id}.json — full message history (lazy loaded, only when needed)
 *
 * This split means listing/searching sessions is fast (SQLite),
 * while full conversation history is only loaded on demand.
 */
import Database from 'better-sqlite3'
import { mkdir, readFile, writeFile, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import type { SessionState, Message } from '@teya/core'

export class SessionStore {
  private db: Database.Database
  private messagesDir: string

  constructor(baseDir?: string) {
    const dir = baseDir || join(process.env.HOME || '.', '.teya')
    mkdirSync(dir, { recursive: true })

    this.db = new Database(join(dir, 'sessions.db'))
    this.db.pragma('journal_mode = WAL')
    this.messagesDir = join(dir, 'sessions')
    mkdirSync(this.messagesDir, { recursive: true })

    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT DEFAULT 'default',
        summary TEXT,
        first_message TEXT,
        topics TEXT DEFAULT '[]',
        tools_used TEXT DEFAULT '[]',
        agents_used TEXT DEFAULT '[]',
        task_ids TEXT DEFAULT '[]',
        transport TEXT DEFAULT 'cli',
        total_cost REAL DEFAULT 0,
        total_turns INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    `)
  }

  // ── Create / Save ──────────────────────────────────────────────────────

  createSession(agentId: string = 'default', transport: string = 'cli'): SessionState {
    const now = new Date()
    const session: SessionState = {
      id: randomUUID(),
      agentId,
      messages: [],
      metadata: {},
      createdAt: now,
      updatedAt: now,
      totalCost: 0,
      totalTurns: 0,
      taskIds: [],
      toolsUsed: [],
      agentsUsed: [],
      topics: [],
      transport,
    }

    this.db.prepare(`
      INSERT INTO sessions (id, agent_id, transport, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(session.id, agentId, transport, now.toISOString(), now.toISOString())

    return session
  }

  async save(session: SessionState): Promise<void> {
    const now = new Date().toISOString()

    // Save messages to JSON file
    await mkdir(this.messagesDir, { recursive: true })
    await writeFile(
      join(this.messagesDir, `${session.id}.json`),
      JSON.stringify(session.messages),
      'utf-8',
    )

    // Extract first user message if not set
    const firstMessage = session.firstMessage
      || session.messages.find(m => m.role === 'user')?.content?.slice(0, 500)

    // Update index
    this.db.prepare(`
      INSERT OR REPLACE INTO sessions
        (id, agent_id, summary, first_message, topics, tools_used, agents_used, task_ids, transport, total_cost, total_turns, message_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.agentId,
      session.summary || null,
      firstMessage || null,
      JSON.stringify(session.topics || []),
      JSON.stringify(session.toolsUsed || []),
      JSON.stringify(session.agentsUsed || []),
      JSON.stringify(session.taskIds || []),
      session.transport || 'cli',
      session.totalCost,
      session.totalTurns,
      session.messages.length,
      (session.createdAt instanceof Date ? session.createdAt.toISOString() : session.createdAt),
      now,
    )
  }

  // ── Load ───────────────────────────────────────────────────────────────

  async load(sessionId: string): Promise<SessionState | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any
    if (!row) return null

    // Load messages from JSON
    let messages: Message[] = []
    try {
      const data = await readFile(join(this.messagesDir, `${sessionId}.json`), 'utf-8')
      messages = JSON.parse(data)
    } catch {
      // Messages file might not exist yet
    }

    return this.rowToSession(row, messages)
  }

  /** Load session metadata only (no messages) — fast */
  getMetadata(sessionId: string): Omit<SessionState, 'messages'> | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any
    if (!row) return null
    return this.rowToSession(row, [])
  }

  // ── Query ──────────────────────────────────────────────────────────────

  async getLatest(): Promise<SessionState | null> {
    const row = this.db.prepare(`
      SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1
    `).get() as any
    if (!row) return null

    // Only return if less than 24 hours old
    const age = Date.now() - new Date(row.updated_at).getTime()
    if (age > 24 * 60 * 60 * 1000) return null

    let messages: Message[] = []
    try {
      const data = await readFile(join(this.messagesDir, `${row.id}.json`), 'utf-8')
      messages = JSON.parse(data)
    } catch {}

    return this.rowToSession(row, messages)
  }

  /** List sessions with metadata (no messages loaded) */
  list(options?: {
    limit?: number
    agentId?: string
    transport?: string
    since?: string
    search?: string
  }): Array<Omit<SessionState, 'messages' | 'metadata'>> {
    const conditions: string[] = []
    const values: any[] = []

    if (options?.agentId) { conditions.push('agent_id = ?'); values.push(options.agentId) }
    if (options?.transport) { conditions.push('transport = ?'); values.push(options.transport) }
    if (options?.since) { conditions.push('updated_at >= ?'); values.push(options.since) }
    if (options?.search) {
      conditions.push('(summary LIKE ? OR first_message LIKE ? OR topics LIKE ?)')
      const term = `%${options.search}%`
      values.push(term, term, term)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = options?.limit || 50

    const rows = this.db.prepare(`
      SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ?
    `).all(...values, limit) as any[]

    return rows.map(r => ({
      id: r.id,
      agentId: r.agent_id,
      summary: r.summary || undefined,
      firstMessage: r.first_message || undefined,
      topics: JSON.parse(r.topics || '[]'),
      toolsUsed: JSON.parse(r.tools_used || '[]'),
      agentsUsed: JSON.parse(r.agents_used || '[]'),
      taskIds: JSON.parse(r.task_ids || '[]'),
      transport: r.transport,
      totalCost: r.total_cost,
      totalTurns: r.total_turns,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    }))
  }

  /** Get sessions that don't have a summary yet (for batch processing) */
  getUnsummarized(limit = 10): Array<{ id: string; firstMessage?: string; messageCount: number }> {
    const rows = this.db.prepare(`
      SELECT id, first_message, message_count FROM sessions
      WHERE summary IS NULL AND message_count > 2
      ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as any[]

    return rows.map(r => ({
      id: r.id,
      firstMessage: r.first_message || undefined,
      messageCount: r.message_count,
    }))
  }

  /** Get sessions from a date range (for daily knowledge extraction) */
  async getSessionsForDate(date: string): Promise<SessionState[]> {
    const rows = this.db.prepare(`
      SELECT id FROM sessions
      WHERE updated_at >= ? AND updated_at < date(?, '+1 day')
        AND message_count > 2
      ORDER BY created_at ASC
    `).all(date, date) as any[]

    const sessions: SessionState[] = []
    for (const row of rows) {
      const session = await this.load(row.id)
      if (session) sessions.push(session)
    }
    return sessions
  }

  /** Update summary and topics after auto-summarization */
  updateSummary(sessionId: string, summary: string, topics: string[]): void {
    this.db.prepare(`
      UPDATE sessions SET summary = ?, topics = ?, updated_at = ? WHERE id = ?
    `).run(summary, JSON.stringify(topics), new Date().toISOString(), sessionId)
  }

  close(): void {
    this.db.close()
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private rowToSession(row: any, messages: Message[]): SessionState {
    return {
      id: row.id,
      agentId: row.agent_id,
      messages,
      summary: row.summary || undefined,
      firstMessage: row.first_message || undefined,
      metadata: {},
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      totalCost: row.total_cost || 0,
      totalTurns: row.total_turns || 0,
      taskIds: JSON.parse(row.task_ids || '[]'),
      toolsUsed: JSON.parse(row.tools_used || '[]'),
      agentsUsed: JSON.parse(row.agents_used || '[]'),
      topics: JSON.parse(row.topics || '[]'),
      transport: row.transport,
    }
  }
}
