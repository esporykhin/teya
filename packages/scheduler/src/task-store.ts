/**
 * @description Persistent task store — SQLite-backed task & execution history.
 */
import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { randomUUID } from 'crypto'

// ── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'

export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  createdBy: string
  assignee?: string
  dueAt?: string
  cron?: string
  lastRunAt?: string
  prompt?: string
  result?: string
  tags: string[]
  timezone: string
  maxRetries: number
  retryCount: number
  timeoutMs: number
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface ExecutionRecord {
  id: string
  taskId: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'completed' | 'failed' | 'timeout'
  result?: string
  error?: string
  agentId?: string
  costUsd: number
  tokenUsageInput: number
  tokenUsageOutput: number
}

export interface CreateTaskInput {
  title: string
  description?: string
  priority?: TaskPriority
  createdBy?: string
  assignee?: string
  dueAt?: string
  cron?: string
  prompt?: string
  tags?: string[]
  timezone?: string
  maxRetries?: number
  timeoutMs?: number
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  assignee?: string
  /** Pass null to clear the field (used by manual-trigger override). */
  dueAt?: string | null
  cron?: string
  prompt?: string
  result?: string
  tags?: string[]
  timezone?: string
  maxRetries?: number
  retryCount?: number
  timeoutMs?: number
  enabled?: boolean
}

export interface TaskQuery {
  status?: TaskStatus | TaskStatus[]
  priority?: TaskPriority
  assignee?: string
  tag?: string
  dueBefore?: string
  cronOnly?: boolean
  enabledOnly?: boolean
  limit?: number
}

// ── TaskStore ────────────────────────────────────────────────────────────────

export class TaskStore {
  private db: Database.Database

  constructor(dbPath?: string) {
    const baseDir = join(process.env.HOME || '.', '.teya')
    mkdirSync(baseDir, { recursive: true })
    this.db = new Database(dbPath || join(baseDir, 'tasks.db'))
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        priority TEXT DEFAULT 'medium',
        created_by TEXT DEFAULT 'user',
        assignee TEXT,
        due_at TEXT,
        cron TEXT,
        last_run_at TEXT,
        prompt TEXT,
        result TEXT,
        tags TEXT DEFAULT '[]',
        timezone TEXT DEFAULT 'Europe/Moscow',
        max_retries INTEGER DEFAULT 0,
        retry_count INTEGER DEFAULT 0,
        timeout_ms INTEGER DEFAULT 120000,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks(due_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_cron ON tasks(cron) WHERE cron IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_enabled ON tasks(enabled) WHERE enabled = 1;

      CREATE TABLE IF NOT EXISTS execution_history (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        result TEXT,
        error TEXT,
        agent_id TEXT,
        cost_usd REAL DEFAULT 0,
        token_usage_input INTEGER DEFAULT 0,
        token_usage_output INTEGER DEFAULT 0,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_exec_task_id ON execution_history(task_id);
      CREATE INDEX IF NOT EXISTS idx_exec_started_at ON execution_history(started_at);
    `)
  }

  // ── Task CRUD ──────────────────────────────────────────────────────────

  create(input: CreateTaskInput): Task {
    const now = new Date().toISOString()
    const id = randomUUID().slice(0, 8)

    this.db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, created_by, assignee, due_at, cron, prompt, tags, timezone, max_retries, timeout_ms, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.title, input.description || '', input.priority || 'medium',
      input.createdBy || 'agent', input.assignee || null, input.dueAt || null,
      input.cron || null, input.prompt || null, JSON.stringify(input.tags || []),
      input.timezone || 'Europe/Moscow', input.maxRetries || 0,
      input.timeoutMs || 120000, now, now,
    )

    return this.get(id)!
  }

  /** Like create() but with a caller-supplied stable ID. Uses INSERT OR IGNORE for idempotency. */
  createWithId(id: string, input: CreateTaskInput): Task {
    const now = new Date().toISOString()

    this.db.prepare(`
      INSERT OR IGNORE INTO tasks (id, title, description, status, priority, created_by, assignee, due_at, cron, prompt, tags, timezone, max_retries, timeout_ms, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.title, input.description || '', input.priority || 'medium',
      input.createdBy || 'system', input.assignee || null, input.dueAt || null,
      input.cron || null, input.prompt || null, JSON.stringify(input.tags || []),
      input.timezone || 'Europe/Moscow', input.maxRetries || 0,
      input.timeoutMs || 120000, now, now,
    )

    return this.get(id)!
  }

  get(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any
    return row ? this.rowToTask(row) : null
  }

  update(id: string, input: UpdateTaskInput): Task | null {
    const now = new Date().toISOString()
    const sets: string[] = ['updated_at = ?']
    const values: any[] = [now]

    const fieldMap: Record<string, string> = {
      title: 'title', description: 'description', status: 'status',
      priority: 'priority', assignee: 'assignee', dueAt: 'due_at',
      cron: 'cron', prompt: 'prompt', result: 'result', timezone: 'timezone',
      maxRetries: 'max_retries', retryCount: 'retry_count', timeoutMs: 'timeout_ms',
    }

    for (const [key, col] of Object.entries(fieldMap)) {
      if ((input as any)[key] !== undefined) {
        sets.push(`${col} = ?`)
        values.push((input as any)[key])
      }
    }
    if (input.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(input.tags)) }
    if (input.enabled !== undefined) { sets.push('enabled = ?'); values.push(input.enabled ? 1 : 0) }

    values.push(id)
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    return this.get(id)
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0
  }

  list(query?: TaskQuery): Task[] {
    const conditions: string[] = []
    const values: any[] = []

    if (query?.status) {
      if (Array.isArray(query.status)) {
        conditions.push(`status IN (${query.status.map(() => '?').join(',')})`)
        values.push(...query.status)
      } else {
        conditions.push('status = ?'); values.push(query.status)
      }
    }
    if (query?.priority) { conditions.push('priority = ?'); values.push(query.priority) }
    if (query?.assignee) { conditions.push('assignee = ?'); values.push(query.assignee) }
    if (query?.tag) { conditions.push("tags LIKE ?"); values.push(`%"${query.tag}"%`) }
    if (query?.dueBefore) { conditions.push('due_at <= ?'); values.push(query.dueBefore) }
    if (query?.cronOnly) { conditions.push('cron IS NOT NULL') }
    if (query?.enabledOnly !== false) { conditions.push('enabled = 1') }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = query?.limit ? `LIMIT ${query.limit}` : 'LIMIT 100'

    const rows = this.db.prepare(`
      SELECT * FROM tasks ${where}
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        due_at ASC NULLS LAST,
        created_at DESC
      ${limit}
    `).all(...values) as any[]

    return rows.map(r => this.rowToTask(r))
  }

  /** All enabled cron tasks (regardless of status) */
  listCronTasks(): Task[] {
    const rows = this.db.prepare(
      "SELECT * FROM tasks WHERE cron IS NOT NULL AND enabled = 1"
    ).all() as any[]
    return rows.map(r => this.rowToTask(r))
  }

  /** One-off tasks that are due now */
  getDueOneOffTasks(): Task[] {
    const now = new Date().toISOString()
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE cron IS NULL AND prompt IS NOT NULL
        AND status = 'pending' AND enabled = 1
        AND due_at IS NOT NULL AND due_at <= ?
    `).all(now) as any[]
    return rows.map(r => this.rowToTask(r))
  }

  markRun(id: string, result?: string): void {
    const now = new Date().toISOString()
    this.db.prepare(
      'UPDATE tasks SET last_run_at = ?, result = ?, updated_at = ? WHERE id = ?'
    ).run(now, result || null, now, id)
  }

  // ── Execution History ──────────────────────────────────────────────────

  createExecution(exec: Omit<ExecutionRecord, 'costUsd' | 'tokenUsageInput' | 'tokenUsageOutput'> & Partial<ExecutionRecord>): void {
    this.db.prepare(`
      INSERT INTO execution_history (id, task_id, started_at, status, agent_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(exec.id, exec.taskId, exec.startedAt, exec.status, exec.agentId || null)
  }

  updateExecution(id: string, updates: Partial<ExecutionRecord>): void {
    const sets: string[] = []
    const values: any[] = []

    if (updates.finishedAt !== undefined) { sets.push('finished_at = ?'); values.push(updates.finishedAt) }
    if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status) }
    if (updates.result !== undefined) { sets.push('result = ?'); values.push(updates.result) }
    if (updates.error !== undefined) { sets.push('error = ?'); values.push(updates.error) }
    if (updates.costUsd !== undefined) { sets.push('cost_usd = ?'); values.push(updates.costUsd) }
    if (updates.tokenUsageInput !== undefined) { sets.push('token_usage_input = ?'); values.push(updates.tokenUsageInput) }
    if (updates.tokenUsageOutput !== undefined) { sets.push('token_usage_output = ?'); values.push(updates.tokenUsageOutput) }

    if (sets.length === 0) return
    values.push(id)
    this.db.prepare(`UPDATE execution_history SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  getExecutions(taskId?: string, limit = 20): ExecutionRecord[] {
    const where = taskId ? 'WHERE task_id = ?' : ''
    const values = taskId ? [taskId] : []
    const rows = this.db.prepare(
      `SELECT * FROM execution_history ${where} ORDER BY started_at DESC LIMIT ?`
    ).all(...values, limit) as any[]

    return rows.map(r => ({
      id: r.id, taskId: r.task_id, startedAt: r.started_at,
      finishedAt: r.finished_at || undefined, status: r.status,
      result: r.result || undefined, error: r.error || undefined,
      agentId: r.agent_id || undefined, costUsd: r.cost_usd || 0,
      tokenUsageInput: r.token_usage_input || 0, tokenUsageOutput: r.token_usage_output || 0,
    }))
  }

  /** Mark orphaned executions (running but daemon died) as failed */
  cleanupOrphanedExecutions(): number {
    const result = this.db.prepare(
      "UPDATE execution_history SET status = 'failed', error = 'daemon restarted', finished_at = ? WHERE status = 'running'"
    ).run(new Date().toISOString())
    return result.changes
  }

  /** Prune old execution records */
  pruneExecutions(olderThanDays = 30): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString()
    return this.db.prepare('DELETE FROM execution_history WHERE started_at < ?').run(cutoff).changes
  }

  close(): void {
    this.db.close()
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private rowToTask(row: any): Task {
    return {
      id: row.id, title: row.title, description: row.description,
      status: row.status, priority: row.priority, createdBy: row.created_by,
      assignee: row.assignee || undefined, dueAt: row.due_at || undefined,
      cron: row.cron || undefined, lastRunAt: row.last_run_at || undefined,
      prompt: row.prompt || undefined, result: row.result || undefined,
      tags: JSON.parse(row.tags || '[]'), timezone: row.timezone || 'Europe/Moscow',
      maxRetries: row.max_retries || 0, retryCount: row.retry_count || 0,
      timeoutMs: row.timeout_ms || 120000, enabled: row.enabled !== 0,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
