/**
 * @description Agent Data Store — SQLite with namespace isolation and CRUD operations
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type { DataSchema, ColumnSchema } from './schema.js'

export class AgentDataStore {
  private db: Database.Database
  private schema: DataSchema
  private namespace: string

  constructor(dbPath: string, schema: DataSchema, namespace: string = 'default') {
    this.namespace = namespace
    this.schema = schema
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  // Internal: prefixed table name for SQL
  private sqlTableName(table: string): string {
    return `${this.namespace}__${table}`
  }

  private sqlType(col: ColumnSchema): string {
    switch (col.type) {
      case 'text': case 'date': case 'datetime': case 'json': case 'enum': return 'TEXT'
      case 'integer': case 'boolean': case 'relation': return 'INTEGER'
      case 'number': return 'REAL'
      default: return 'TEXT'
    }
  }

  private migrate(): void {
    for (const [tableName, tableDef] of Object.entries(this.schema.tables)) {
      const sqlName = this.sqlTableName(tableName)
      const columns: string[] = ['id INTEGER PRIMARY KEY AUTOINCREMENT']
      const indices: string[] = []

      for (const [colName, colDef] of Object.entries(tableDef.columns)) {
        let sql = `${colName} ${this.sqlType(colDef)}`
        if (colDef.required) sql += ' NOT NULL'
        if (colDef.unique) sql += ' UNIQUE'
        if (colDef.default !== undefined) {
          const def = typeof colDef.default === 'string' ? `'${colDef.default}'` : colDef.default
          sql += ` DEFAULT ${def}`
        }
        if (colDef.type === 'relation' && colDef.table) {
          const refSqlName = this.sqlTableName(colDef.table)
          sql += ` REFERENCES ${refSqlName}(id)`
          if (colDef.on_delete) sql += ` ON DELETE ${colDef.on_delete === 'cascade' ? 'CASCADE' : 'SET NULL'}`
        }
        columns.push(sql)
        if (colDef.index) indices.push(colName)
      }

      columns.push('created_at TEXT DEFAULT (datetime("now"))')
      columns.push('updated_at TEXT DEFAULT (datetime("now"))')

      this.db.exec(`CREATE TABLE IF NOT EXISTS ${sqlName} (${columns.join(', ')})`)
      for (const idx of indices) {
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${sqlName}_${idx} ON ${sqlName}(${idx})`)
      }
    }
  }

  create(table: string, data: Record<string, unknown>): Record<string, unknown> {
    this.validateTable(table)
    const sqlName = this.sqlTableName(table)
    const keys = Object.keys(data)
    const placeholders = keys.map(() => '?')
    const values = keys.map(k => this.serializeValue(data[k], this.schema.tables[table].columns[k]))

    const stmt = this.db.prepare(`INSERT INTO ${sqlName} (${keys.join(',')}) VALUES (${placeholders.join(',')})`)
    const result = stmt.run(...values)
    return this.get(table, result.lastInsertRowid as number)!
  }

  get(table: string, id: number): Record<string, unknown> | null {
    this.validateTable(table)
    const sqlName = this.sqlTableName(table)
    const row = this.db.prepare(`SELECT * FROM ${sqlName} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? this.deserializeRow(row, table) : null
  }

  list(
    table: string,
    options: { where?: Record<string, unknown>; order_by?: string; limit?: number; offset?: number } = {},
  ): Record<string, unknown>[] {
    this.validateTable(table)
    const sqlName = this.sqlTableName(table)
    let sql = `SELECT * FROM ${sqlName}`
    const params: unknown[] = []

    if (options.where && Object.keys(options.where).length > 0) {
      const conditions: string[] = []
      for (const [key, value] of Object.entries(options.where)) {
        if (typeof value === 'object' && value !== null) {
          // Operator format: { gt: 100, like: "%test%" }
          for (const [op, val] of Object.entries(value as Record<string, unknown>)) {
            const sqlOp = ({ eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE' } as Record<string, string>)[op] || '='
            conditions.push(`${key} ${sqlOp} ?`)
            params.push(val)
          }
        } else {
          conditions.push(`${key} = ?`)
          params.push(value)
        }
      }
      sql += ` WHERE ${conditions.join(' AND ')}`
    }

    if (options.order_by) {
      const desc = options.order_by.startsWith('-')
      const col = desc ? options.order_by.slice(1) : options.order_by
      sql += ` ORDER BY ${col} ${desc ? 'DESC' : 'ASC'}`
    }

    sql += ` LIMIT ${options.limit || 20} OFFSET ${options.offset || 0}`

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map(r => this.deserializeRow(r, table))
  }

  update(table: string, id: number, data: Record<string, unknown>): Record<string, unknown> | null {
    this.validateTable(table)
    const sqlName = this.sqlTableName(table)
    const keys = Object.keys(data)
    const sets = keys.map(k => `${k} = ?`)
    sets.push('updated_at = datetime("now")')
    const values = keys.map(k => this.serializeValue(data[k], this.schema.tables[table].columns[k]))

    this.db.prepare(`UPDATE ${sqlName} SET ${sets.join(',')} WHERE id = ?`).run(...values, id)
    return this.get(table, id)
  }

  delete(table: string, id: number): boolean {
    this.validateTable(table)
    const sqlName = this.sqlTableName(table)
    const result = this.db.prepare(`DELETE FROM ${sqlName} WHERE id = ?`).run(id)
    return result.changes > 0
  }

  count(table: string, where?: Record<string, unknown>): number {
    this.validateTable(table)
    const sqlName = this.sqlTableName(table)
    let sql = `SELECT COUNT(*) as count FROM ${sqlName}`
    const params: unknown[] = []

    if (where && Object.keys(where).length > 0) {
      const conditions = Object.entries(where).map(([key]) => {
        params.push(where[key])
        return `${key} = ?`
      })
      sql += ` WHERE ${conditions.join(' AND ')}`
    }

    return (this.db.prepare(sql).get(...params) as { count: number }).count
  }

  listTables(): Array<{ name: string; description: string; count: number }> {
    return Object.entries(this.schema.tables).map(([name, def]) => ({
      name,
      description: def.description,
      count: this.count(name),
    }))
  }

  private validateTable(table: string): void {
    if (!this.schema.tables[table]) throw new Error(`Table "${table}" not found in schema`)
  }

  private serializeValue(value: unknown, colDef?: ColumnSchema): unknown {
    if (value === undefined || value === null) return null
    if (colDef?.type === 'json') return JSON.stringify(value)
    if (colDef?.type === 'boolean') return value ? 1 : 0
    return value
  }

  private deserializeRow(row: Record<string, unknown>, table: string): Record<string, unknown> {
    const result = { ...row }
    for (const [colName, colDef] of Object.entries(this.schema.tables[table].columns)) {
      if (colDef.type === 'json' && typeof result[colName] === 'string') {
        try { result[colName] = JSON.parse(result[colName] as string) } catch { /* keep as string */ }
      }
      if (colDef.type === 'boolean') result[colName] = result[colName] === 1
    }
    return result
  }

  close(): void { this.db.close() }
}
