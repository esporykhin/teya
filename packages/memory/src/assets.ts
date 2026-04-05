/**
 * @description Asset store — track files, photos, documents with metadata and hash storage
 */
import Database from 'better-sqlite3'
import { join, dirname, extname, basename } from 'path'
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'

export interface Asset {
  id: number
  file_path: string
  original_name: string
  description: string
  source: 'user' | 'agent'
  mime_type: string
  tags: string[]
  session_id: string | null
  related_entity_id: number | null
  created_at: string
}

export class AssetStore {
  private db: Database.Database
  private assetsDir: string

  constructor(dbPath?: string, assetsDir?: string) {
    const baseDir = dbPath ? dirname(dbPath) : join(
      process.env.HOME || process.env.USERPROFILE || '.',
      '.teya', 'memory'
    )
    mkdirSync(baseDir, { recursive: true })

    this.db = new Database(dbPath || join(baseDir, 'assets.db'))
    this.db.pragma('journal_mode = WAL')

    this.assetsDir = assetsDir || join(
      process.env.HOME || process.env.USERPROFILE || '.',
      '.teya', 'assets'
    )
    mkdirSync(this.assetsDir, { recursive: true })

    this.initTables()
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        original_name TEXT NOT NULL,
        description TEXT DEFAULT '',
        source TEXT NOT NULL DEFAULT 'agent',
        mime_type TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        session_id TEXT,
        related_entity_id INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_assets_description ON assets(description);
      CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at);
      CREATE INDEX IF NOT EXISTS idx_assets_source ON assets(source);
    `)
  }

  save(options: {
    filePath: string
    originalName?: string
    description: string
    source: 'user' | 'agent'
    mimeType?: string
    tags?: string[]
    sessionId?: string
    relatedEntityId?: number
  }): Asset {
    const ext = extname(options.filePath) || ''
    const content = readFileSync(options.filePath)
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
    const storedName = `${hash}${ext}`
    const storedPath = join(this.assetsDir, storedName)

    if (!existsSync(storedPath)) {
      copyFileSync(options.filePath, storedPath)
    }

    const result = this.db.prepare(`
      INSERT INTO assets (file_path, original_name, description, source, mime_type, tags, session_id, related_entity_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      storedPath,
      options.originalName || basename(options.filePath),
      options.description,
      options.source,
      options.mimeType || this.guessMimeType(ext),
      JSON.stringify(options.tags || []),
      options.sessionId || null,
      options.relatedEntityId || null,
    )

    return this.get(result.lastInsertRowid as number)!
  }

  saveContent(options: {
    content: Buffer | string
    fileName: string
    description: string
    source: 'user' | 'agent'
    mimeType?: string
    tags?: string[]
    sessionId?: string
  }): Asset {
    const ext = extname(options.fileName) || ''
    const buf = typeof options.content === 'string' ? Buffer.from(options.content) : options.content
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
    const storedName = `${hash}${ext}`
    const storedPath = join(this.assetsDir, storedName)

    if (!existsSync(storedPath)) {
      writeFileSync(storedPath, buf)
    }

    const result = this.db.prepare(`
      INSERT INTO assets (file_path, original_name, description, source, mime_type, tags, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      storedPath,
      options.fileName,
      options.description,
      options.source,
      options.mimeType || this.guessMimeType(ext),
      JSON.stringify(options.tags || []),
      options.sessionId || null,
    )

    return this.get(result.lastInsertRowid as number)!
  }

  get(id: number): Asset | null {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? { ...row, tags: JSON.parse(row.tags as string) } as Asset : null
  }

  search(options: { query?: string; after?: string; before?: string; source?: string; limit?: number }): Asset[] {
    let sql = 'SELECT * FROM assets WHERE 1=1'
    const params: unknown[] = []

    if (options.query) {
      const words = options.query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
      if (words.length > 0) {
        const conditions = words.map(() => 'LOWER(description) LIKE ?')
        sql += ` AND (${conditions.join(' OR ')})`
        params.push(...words.map(w => `%${w}%`))
      }
    }

    if (options.after) {
      sql += ' AND created_at >= ?'
      params.push(options.after)
    }
    if (options.before) {
      sql += ' AND created_at <= ?'
      params.push(options.before)
    }
    if (options.source) {
      sql += ' AND source = ?'
      params.push(options.source)
    }

    sql += ` ORDER BY created_at DESC LIMIT ${options.limit || 10}`

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map(r => ({ ...r, tags: JSON.parse(r.tags as string) }) as Asset)
  }

  recent(limit: number = 10): Asset[] {
    const rows = this.db.prepare('SELECT * FROM assets ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]
    return rows.map(r => ({ ...r, tags: JSON.parse(r.tags as string) }) as Asset)
  }

  private guessMimeType(ext: string): string {
    const map: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf', '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown',
      '.json': 'application/json', '.xml': 'application/xml',
      '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav',
    }
    return map[ext.toLowerCase()] || 'application/octet-stream'
  }

  close(): void { this.db.close() }
}
