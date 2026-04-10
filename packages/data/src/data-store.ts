import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

export interface ColumnDef {
  name: string
  type: 'text' | 'integer' | 'real' | 'boolean' | 'datetime' | 'json'
  not_null?: boolean
  unique?: boolean
  default?: string | number | boolean
  primary_key?: boolean
  references?: string
}

export interface IndexDef {
  columns: string[]
  unique?: boolean
}

type RequiredAccess = 'read' | 'write' | 'owner'
type AccessLevel = 'owner' | 'read' | 'write' | 'none'

type TableMetaRow = {
  name: string
  namespace: string
  owner: string
  description: string
  schema_json: string
  constraints_json: string
  created_at: string
  updated_at: string
}

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/

export class DataStore {
  private db: Database.Database
  private namespace: string
  private mainNamespace: string

  constructor(dbPath: string, namespace: string, mainNamespace: string = 'teya') {
    this.namespace = namespace
    this.mainNamespace = mainNamespace

    mkdirSync(dirname(dbPath), { recursive: true })

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    this.initMeta()
  }

  private initMeta(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _tables (
        name TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        owner TEXT NOT NULL,
        description TEXT DEFAULT '',
        schema_json TEXT NOT NULL,
        constraints_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS _table_access (
        table_name TEXT NOT NULL REFERENCES _tables(name),
        namespace TEXT NOT NULL,
        access TEXT NOT NULL CHECK(access IN ('owner','read','write','none')),
        granted_by TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (table_name, namespace)
      );
    `)
  }

  hasAccess(tableName: string, required: RequiredAccess): boolean {
    if (this.namespace === this.mainNamespace || this.namespace === 'user') {
      return true
    }

    const accessRow = this.db
      .prepare('SELECT access FROM _table_access WHERE table_name = ? AND namespace = ?')
      .get(tableName, this.namespace) as { access: AccessLevel } | undefined

    if (accessRow) {
      return this.satisfiesAccess(accessRow.access, required)
    }

    const ownerRow = this.db
      .prepare('SELECT owner FROM _tables WHERE name = ?')
      .get(tableName) as { owner: string } | undefined

    if (!ownerRow) {
      return false
    }

    if (ownerRow.owner === this.namespace) {
      return this.satisfiesAccess('owner', required)
    }

    return false
  }

  visibleTables(): TableMetaRow[] {
    if (this.namespace === this.mainNamespace || this.namespace === 'user') {
      return this.db.prepare('SELECT * FROM _tables ORDER BY name').all() as TableMetaRow[]
    }

    return this.db
      .prepare(`
        SELECT t.*
        FROM _tables t
        LEFT JOIN _table_access a
          ON a.table_name = t.name
          AND a.namespace = ?
        WHERE
          COALESCE(
            a.access,
            CASE WHEN t.owner = ? THEN 'owner' ELSE 'none' END
          ) != 'none'
        ORDER BY t.name
      `)
      .all(this.namespace, this.namespace) as TableMetaRow[]
  }

  createTable(args: Record<string, unknown>): string {
    const tableName = this.requiredString(args.table, 'table')
    this.validateIdentifier(tableName, 'table')

    const exists = this.db.prepare('SELECT 1 FROM _tables WHERE name = ?').get(tableName)
    if (exists) {
      throw new Error(`Table '${tableName}' already exists.`)
    }

    const rawColumns = Array.isArray(args.columns) ? (args.columns as ColumnDef[]) : []
    if (rawColumns.length === 0) {
      throw new Error('create_table requires non-empty columns array.')
    }

    const indexes = Array.isArray(args.indexes) ? (args.indexes as IndexDef[]) : []
    const description = typeof args.description === 'string' ? args.description : ''

    const columns = rawColumns.map((col) => this.normalizeColumn(col))
    this.validateUniqueColumnNames(columns)

    const hasPrimaryKey = columns.some((c) => c.primary_key)
    const hasCreatedAt = columns.some((c) => c.name === 'created_at')
    const hasUpdatedAt = columns.some((c) => c.name === 'updated_at')

    const sqlColumns: string[] = []
    if (!hasPrimaryKey) {
      sqlColumns.push('"id" INTEGER PRIMARY KEY AUTOINCREMENT')
    }

    for (const col of columns) {
      sqlColumns.push(this.columnToSql(col))
    }

    if (!hasCreatedAt) {
      sqlColumns.push('"created_at" TEXT DEFAULT (datetime(\'now\'))')
    }
    if (!hasUpdatedAt) {
      sqlColumns.push('"updated_at" TEXT DEFAULT (datetime(\'now\'))')
    }

    this.db.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${sqlColumns.join(', ')})`)

    for (const idx of indexes) {
      this.validateIndex(idx, columns, !hasPrimaryKey)
      const suffix = idx.columns.join('_')
      const idxName = `idx_${tableName}_${suffix}${idx.unique ? '_u' : ''}`
      const colsSql = idx.columns.map((c) => `"${c}"`).join(', ')
      this.db.exec(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${idxName}" ON "${tableName}" (${colsSql})`)
    }

    this.db
      .prepare(`
        INSERT INTO _tables (name, namespace, owner, description, schema_json, constraints_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        tableName,
        this.namespace,
        this.namespace,
        description,
        JSON.stringify(columns),
        JSON.stringify(indexes),
      )

    this.db
      .prepare(`
        INSERT INTO _table_access (table_name, namespace, access, granted_by)
        VALUES (?, ?, 'owner', ?)
      `)
      .run(tableName, this.namespace, this.namespace)

    return `Table '${tableName}' created with ${columns.length} columns.`
  }

  insert(args: Record<string, unknown>): string {
    const table = this.requiredString(args.table, 'table')
    const data = this.requiredObject(args.data, 'data')

    this.ensureAccessible(table, 'write')

    const schema = this.getSchema(table)
    const keys = Object.keys(data)
    if (keys.length === 0) {
      throw new Error('insert requires at least one field in data.')
    }

    const columnsSql = keys.map((k) => `"${k}"`).join(', ')
    const valuesSql = keys.map(() => '?').join(', ')
    const values = keys.map((k) => this.serializeForDb(data[k], schema.find((c) => c.name === k)))

    const result = this.db.prepare(`INSERT INTO "${table}" (${columnsSql}) VALUES (${valuesSql})`).run(...values)

    return `Inserted row #${Number(result.lastInsertRowid)} into '${table}'.`
  }

  upsert(args: Record<string, unknown>): string {
    const table = this.requiredString(args.table, 'table')
    const data = this.requiredObject(args.data, 'data')
    const matchOn = Array.isArray(args.match_on) ? (args.match_on as string[]) : []

    if (matchOn.length === 0) {
      throw new Error('upsert requires non-empty match_on array.')
    }

    this.ensureAccessible(table, 'write')

    const schema = this.getSchema(table)
    const tx = this.db.transaction(() => {
      const whereSql = matchOn.map((col) => `"${col}" = ?`).join(' AND ')
      const whereVals = matchOn.map((col) => {
        if (!(col in data)) {
          throw new Error(`upsert data is missing match_on column '${col}'.`)
        }
        return this.serializeForDb(data[col], schema.find((c) => c.name === col))
      })

      const existing = this.db
        .prepare(`SELECT id FROM "${table}" WHERE ${whereSql} LIMIT 1`)
        .get(...whereVals) as { id: number } | undefined

      if (existing) {
        const keys = Object.keys(data)
        const setSql = keys.map((k) => `"${k}" = ?`)
        setSql.push('"updated_at" = datetime(\'now\')')
        const vals = keys.map((k) => this.serializeForDb(data[k], schema.find((c) => c.name === k)))
        this.db.prepare(`UPDATE "${table}" SET ${setSql.join(', ')} WHERE id = ?`).run(...vals, existing.id)
        return `Updated row #${existing.id} in '${table}'.`
      }

      const keys = Object.keys(data)
      const colSql = keys.map((k) => `"${k}"`).join(', ')
      const valSql = keys.map(() => '?').join(', ')
      const vals = keys.map((k) => this.serializeForDb(data[k], schema.find((c) => c.name === k)))
      const inserted = this.db.prepare(`INSERT INTO "${table}" (${colSql}) VALUES (${valSql})`).run(...vals)
      return `Inserted row #${Number(inserted.lastInsertRowid)} into '${table}'.`
    })

    return tx()
  }

  update(args: Record<string, unknown>): string {
    const table = this.requiredString(args.table, 'table')
    const data = this.requiredObject(args.data, 'data')

    this.ensureAccessible(table, 'write')

    const schema = this.getSchema(table)
    const setKeys = Object.keys(data)
    if (setKeys.length === 0) {
      throw new Error('update requires at least one field in data.')
    }

    const setSql = setKeys.map((k) => `"${k}" = ?`)
    setSql.push('"updated_at" = datetime(\'now\')')
    const params = setKeys.map((k) => this.serializeForDb(data[k], schema.find((c) => c.name === k)))

    const where = this.buildIdOrWhereClause(args.id, args.where)
    const sql = `UPDATE "${table}" SET ${setSql.join(', ')} WHERE ${where.conditions}`
    const result = this.db.prepare(sql).run(...params, ...where.params)

    return `Updated ${result.changes} row(s) in '${table}'.`
  }

  delete(args: Record<string, unknown>): string {
    const table = this.requiredString(args.table, 'table')
    this.ensureAccessible(table, 'write')

    const where = this.buildIdOrWhereClause(args.id, args.where)
    const result = this.db.prepare(`DELETE FROM "${table}" WHERE ${where.conditions}`).run(...where.params)

    return `Deleted ${result.changes} row(s) from '${table}'.`
  }

  list(args: Record<string, unknown>): string {
    const table = this.requiredString(args.table, 'table')
    this.ensureAccessible(table, 'read')

    const where = this.buildWhereClause(args.where)
    const orderBy = this.buildOrderByClause(args.order_by)
    const rawLimit = typeof args.limit === 'number' ? Math.floor(args.limit) : 50
    const limit = Math.max(1, Math.min(200, rawLimit || 50))
    const rawOffset = typeof args.offset === 'number' ? Math.floor(args.offset) : 0
    const offset = Math.max(0, rawOffset)

    const rows = this.db
      .prepare(`SELECT * FROM "${table}" ${where.sql} ${orderBy} LIMIT ? OFFSET ?`)
      .all(...where.params, limit, offset) as Record<string, unknown>[]

    const schema = this.getSchema(table)
    const parsedRows = rows.map((r) => this.deserializeRow(r, schema))

    if (parsedRows.length === 0) {
      return `No rows in '${table}'.`
    }

    return parsedRows
      .map((row) => {
        const rowId = typeof row.id === 'number' || typeof row.id === 'string' ? row.id : '?'
        const pairs = Object.entries(row).map(([k, v]) => `${k}=${this.formatValue(v)}`)
        return `Row #${rowId}: ${pairs.join(', ')}`
      })
      .join('\n')
  }

  get(args: Record<string, unknown>): string {
    const table = this.requiredString(args.table, 'table')
    const id = this.requiredNumber(args.id, 'id')

    this.ensureAccessible(table, 'read')

    const row = this.db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (!row) {
      return `Row #${id} not found in '${table}'.`
    }

    const schema = this.getSchema(table)
    const parsed = this.deserializeRow(row, schema)
    const details = Object.entries(parsed)
      .map(([k, v]) => `  ${k}: ${this.formatValue(v)}`)
      .join('\n')

    return `Row #${id} in '${table}':\n${details}`
  }

  count(args: Record<string, unknown>): string {
    const table = this.requiredString(args.table, 'table')
    this.ensureAccessible(table, 'read')

    const where = this.buildWhereClause(args.where)
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM "${table}" ${where.sql}`).get(...where.params) as { count: number }

    return `${row.count} rows in '${table}'${where.params.length > 0 ? ' matching filter.' : '.'}`
  }

  schema(args: Record<string, unknown>): string {
    const table = typeof args.table === 'string' ? args.table : undefined

    if (!table) {
      const visible = this.visibleTables()
      const lines = [`Tables accessible to namespace '${this.namespace}':`]

      for (const row of visible) {
        const countRow = this.db.prepare(`SELECT COUNT(*) as count FROM "${row.name}"`).get() as { count: number }
        lines.push(`- ${row.name}: ${row.description || ''} (${countRow.count} rows, owner: ${row.owner}, created: ${row.created_at})`)
      }

      if (visible.length === 0) {
        lines.push('- none')
      }

      return lines.join('\n')
    }

    this.ensureAccessible(table, 'read')

    const meta = this.getTableMeta(table)
    if (!meta) {
      throw new Error(`Table '${table}' not found. Use action=schema to see available tables.`)
    }

    const cols = this.getSchema(table)
    const indexes = this.getIndexes(table)
    const countRow = this.db.prepare(`SELECT COUNT(*) as count FROM "${table}"`).get() as { count: number }

    // Use PRAGMA to get full column list including auto-added columns
    const pragmaCols = this.db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null; pk: number
    }>
    const userColNames = new Set(cols.map((c) => c.name))

    const colLines = pragmaCols.map((col) => {
      const userCol = cols.find((c) => c.name === col.name)
      const flags: string[] = [col.type]
      if (col.pk) flags.push('PRIMARY KEY')
      if (col.notnull && !col.pk) flags.push('NOT NULL')
      if (userCol?.unique) flags.push('UNIQUE')
      if (col.dflt_value !== null) flags.push(`DEFAULT ${col.dflt_value}`)
      if (userCol?.references) flags.push(`REFERENCES ${userCol.references}`)
      if (!userColNames.has(col.name)) flags.push('auto')
      return `  - ${col.name} (${flags.join(', ')})`
    })

    const idxLines = indexes.length
      ? indexes.map((idx) => `  - (${idx.columns.join(', ')})${idx.unique ? ' UNIQUE' : ''}`)
      : ['  - none']

    return [
      `Table '${table}':`,
      `  Description: ${meta.description || ''}`,
      `  Owner: ${meta.owner}`,
      '  Columns:',
      ...colLines,
      '  Indexes:',
      ...idxLines,
      `  Rows: ${countRow.count}`,
    ].join('\n')
  }

  alterTable(args: Record<string, unknown>): string {
    const table = this.requiredString(args.table, 'table')
    this.ensureAccessible(table, 'owner')

    const addColumns = Array.isArray(args.add_columns) ? (args.add_columns as ColumnDef[]) : []
    if (addColumns.length === 0) {
      throw new Error('alter_table requires non-empty add_columns array.')
    }

    const current = this.getSchema(table)
    const currentNames = new Set(current.map((c) => c.name))

    for (const raw of addColumns) {
      const col = this.normalizeColumn(raw)
      if (col.primary_key) {
        throw new Error('Cannot add PRIMARY KEY columns via alter_table.')
      }
      if (currentNames.has(col.name)) {
        throw new Error(`Column '${col.name}' already exists in '${table}'.`)
      }

      this.db.exec(`ALTER TABLE "${table}" ADD COLUMN ${this.columnToSql(col)}`)
      current.push(col)
      currentNames.add(col.name)
    }

    this.db
      .prepare(`
        UPDATE _tables
        SET schema_json = ?, updated_at = datetime('now')
        WHERE name = ?
      `)
      .run(JSON.stringify(current), table)

    return `Added ${addColumns.length} column(s) to '${table}'.`
  }

  dropTable(args: Record<string, unknown>): string {
    const table = this.requiredString(args.table, 'table')
    this.ensureAccessible(table, 'owner')

    this.db.exec(`DROP TABLE IF EXISTS "${table}"`)
    this.db.prepare('DELETE FROM _table_access WHERE table_name = ?').run(table)
    this.db.prepare('DELETE FROM _tables WHERE name = ?').run(table)

    return `Table '${table}' dropped.`
  }

  grant(args: Record<string, unknown>): string {
    const table = this.requiredString(args.table, 'table')
    const targetNamespace = this.requiredString(args.namespace, 'namespace')
    const access = this.requiredString(args.access, 'access') as AccessLevel

    if (!['read', 'write', 'none'].includes(access)) {
      throw new Error("access must be one of: 'read', 'write', 'none'.")
    }

    this.ensureAccessible(table, 'owner')

    this.db
      .prepare(`
        INSERT OR REPLACE INTO _table_access (table_name, namespace, access, granted_by)
        VALUES (?, ?, ?, ?)
      `)
      .run(table, targetNamespace, access, this.namespace)

    return `Granted '${access}' access to '${targetNamespace}' on table '${table}'.`
  }

  transfer(args: Record<string, unknown>): string {
    const table = this.requiredString(args.table, 'table')
    const newOwner = this.requiredString(args.new_owner, 'new_owner')

    this.ensureAccessible(table, 'owner')

    this.db
      .prepare(`
        UPDATE _tables
        SET owner = ?, updated_at = datetime('now')
        WHERE name = ?
      `)
      .run(newOwner, table)

    this.db
      .prepare(`
        UPDATE _table_access
        SET access = 'write'
        WHERE table_name = ? AND namespace = ?
      `)
      .run(table, this.namespace)

    this.db
      .prepare(`
        INSERT OR REPLACE INTO _table_access (table_name, namespace, access, granted_by)
        VALUES (?, ?, 'owner', ?)
      `)
      .run(table, newOwner, this.namespace)

    return `Ownership of '${table}' transferred to '${newOwner}'.`
  }

  sql(args: Record<string, unknown>): string {
    const query = this.requiredString(args.query, 'query').trim()
    if (!/^select\b/i.test(query)) {
      return 'Only SELECT queries are allowed in sql action.'
    }

    const rows = this.db.prepare(query).all() as Record<string, unknown>[]
    if (rows.length === 0) {
      return 'No results.'
    }

    return rows
      .map((row, index) => {
        const pairs = Object.entries(row).map(([k, v]) => `${k}=${this.formatValue(v)}`)
        return `Row ${index + 1}: ${pairs.join(', ')}`
      })
      .join('\n')
  }

  close(): void {
    this.db.close()
  }

  private satisfiesAccess(current: AccessLevel, required: RequiredAccess): boolean {
    if (current === 'none') {
      return false
    }

    if (required === 'read') {
      return current === 'read' || current === 'write' || current === 'owner'
    }

    if (required === 'write') {
      return current === 'write' || current === 'owner'
    }

    return current === 'owner'
  }

  private getTableMeta(table: string): TableMetaRow | undefined {
    return this.db.prepare('SELECT * FROM _tables WHERE name = ?').get(table) as TableMetaRow | undefined
  }

  private introspectColumns(table: string): ColumnDef[] {
    const rows = this.db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>

    return rows.map((row) => ({
      name: row.name,
      type: this.sqliteTypeToColumnType(row.type),
      not_null: row.notnull === 1,
      primary_key: row.pk === 1,
      default: this.parseDefaultValue(row.dflt_value),
    }))
  }

  private ensureAccessible(table: string, required: RequiredAccess): void {
    const meta = this.getTableMeta(table)
    if (!meta) {
      throw new Error(`Table '${table}' not found. Use action=schema to see available tables.`)
    }

    if (!this.hasAccess(table, 'read')) {
      throw new Error(`Table '${table}' not found. Use action=schema to see available tables.`)
    }

    if (!this.hasAccess(table, required)) {
      throw new Error(`Access denied: namespace '${this.namespace}' needs ${required} access on table '${table}'.`)
    }
  }

  private getSchema(table: string): ColumnDef[] {
    const meta = this.getTableMeta(table)
    if (!meta) {
      return []
    }

    try {
      const parsed = JSON.parse(meta.schema_json)
      return Array.isArray(parsed) ? (parsed as ColumnDef[]) : []
    } catch {
      return []
    }
  }

  private getIndexes(table: string): IndexDef[] {
    const meta = this.getTableMeta(table)
    if (!meta) {
      return []
    }

    try {
      const parsed = JSON.parse(meta.constraints_json)
      return Array.isArray(parsed) ? (parsed as IndexDef[]) : []
    } catch {
      return []
    }
  }

  private buildIdOrWhereClause(idValue: unknown, whereValue: unknown): { conditions: string; params: unknown[] } {
    if (typeof idValue === 'number' && Number.isFinite(idValue)) {
      return { conditions: 'id = ?', params: [idValue] }
    }

    const where = this.requiredObject(whereValue, 'where')
    const built = this.buildWhereClause(where, true)
    return { conditions: built.conditions, params: built.params }
  }

  private buildWhereClause(whereValue: unknown, required: boolean = false): { conditions: string; sql: string; params: unknown[] } {
    if (whereValue === undefined || whereValue === null) {
      if (required) {
        throw new Error('Either id or where must be provided.')
      }
      return { conditions: '', sql: '', params: [] }
    }

    const where = this.requiredObject(whereValue, 'where')
    const entries = Object.entries(where)
    if (entries.length === 0) {
      if (required) {
        throw new Error('where must include at least one field.')
      }
      return { conditions: '', sql: '', params: [] }
    }

    const clauses: string[] = []
    const params: unknown[] = []

    for (const [key, value] of entries) {
      this.validateIdentifier(key, 'column')
      clauses.push(`"${key}" = ?`)
      params.push(value)
    }

    const conditions = clauses.join(' AND ')
    return { conditions, sql: `WHERE ${conditions}`, params }
  }

  private buildOrderByClause(orderByValue: unknown): string {
    if (typeof orderByValue !== 'string' || orderByValue.trim().length === 0) {
      return ''
    }

    const trimmed = orderByValue.trim()
    const desc = trimmed.startsWith('-')
    const col = desc ? trimmed.slice(1) : trimmed
    this.validateIdentifier(col, 'column')

    return `ORDER BY "${col}" ${desc ? 'DESC' : 'ASC'}`
  }

  private normalizeColumn(col: ColumnDef): ColumnDef {
    if (!col || typeof col !== 'object') {
      throw new Error('Column definitions must be objects.')
    }

    const normalized: ColumnDef = {
      name: this.requiredString(col.name, 'column.name'),
      type: col.type,
      not_null: Boolean(col.not_null),
      unique: Boolean(col.unique),
      primary_key: Boolean(col.primary_key),
    }

    this.validateIdentifier(normalized.name, 'column')

    if (!['text', 'integer', 'real', 'boolean', 'datetime', 'json'].includes(col.type)) {
      throw new Error(`Unsupported column type '${String(col.type)}' for '${normalized.name}'.`)
    }

    if (col.default !== undefined) {
      normalized.default = col.default
    }

    if (col.references !== undefined) {
      normalized.references = String(col.references)
    }

    return normalized
  }

  private validateIndex(index: IndexDef, columns: ColumnDef[], hasAutoId: boolean): void {
    if (!Array.isArray(index.columns) || index.columns.length === 0) {
      throw new Error('Each index must define non-empty columns array.')
    }

    const available = new Set(columns.map((c) => c.name))
    if (hasAutoId) {
      available.add('id')
    }

    for (const col of index.columns) {
      this.validateIdentifier(col, 'index column')
      if (!available.has(col)) {
        throw new Error(`Index references unknown column '${col}'.`)
      }
    }
  }

  private validateUniqueColumnNames(columns: ColumnDef[]): void {
    const seen = new Set<string>()
    for (const col of columns) {
      if (seen.has(col.name)) {
        throw new Error(`Duplicate column name '${col.name}'.`)
      }
      seen.add(col.name)
    }
  }

  private validateIdentifier(value: string, kind: string): void {
    if (!IDENTIFIER_RE.test(value)) {
      throw new Error(`Invalid ${kind} name '${value}'. Must match ${IDENTIFIER_RE.toString()}.`)
    }
  }

  private sqliteType(type: ColumnDef['type']): string {
    switch (type) {
      case 'text':
        return 'TEXT'
      case 'integer':
        return 'INTEGER'
      case 'real':
        return 'REAL'
      case 'boolean':
        return 'INTEGER'
      case 'datetime':
        return 'TEXT'
      case 'json':
        return 'TEXT'
      default:
        return 'TEXT'
    }
  }

  private sqliteTypeToColumnType(type: string): ColumnDef['type'] {
    const upper = (type || '').toUpperCase()
    if (upper.includes('INT')) return 'integer'
    if (upper.includes('REAL') || upper.includes('FLOA') || upper.includes('DOUB')) return 'real'
    return 'text'
  }

  private parseDefaultValue(raw: string | null): string | number | boolean | undefined {
    if (raw === null || raw === undefined) return undefined
    const trimmed = raw.trim()
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return trimmed.slice(1, -1)
    }
    if (trimmed === '1') return true
    if (trimmed === '0') return false
    const asNumber = Number(trimmed)
    return Number.isNaN(asNumber) ? trimmed : asNumber
  }

  private columnToSql(col: ColumnDef): string {
    const parts: string[] = [`"${col.name}" ${this.sqliteType(col.type)}`]

    if (col.primary_key) {
      parts.push('PRIMARY KEY')
    }
    if (col.not_null) {
      parts.push('NOT NULL')
    }
    if (col.unique) {
      parts.push('UNIQUE')
    }
    if (col.default !== undefined) {
      parts.push(`DEFAULT ${this.sqlLiteral(col.default, col.type)}`)
    }
    if (col.references) {
      parts.push(`REFERENCES ${col.references}`)
    }

    return parts.join(' ')
  }

  private sqlLiteral(value: string | number | boolean, type?: ColumnDef['type']): string {
    if (typeof value === 'number') {
      return String(value)
    }

    if (typeof value === 'boolean') {
      return value ? '1' : '0'
    }

    if (type === 'boolean') {
      return value === 'true' ? '1' : value === 'false' ? '0' : `'${String(value).replace(/'/g, "''")}'`
    }

    return `'${String(value).replace(/'/g, "''")}'`
  }

  private serializeForDb(value: unknown, col?: ColumnDef): unknown {
    if (!col) {
      return value
    }

    if (value === undefined) {
      return null
    }

    if (col.type === 'json') {
      return value === null ? null : JSON.stringify(value)
    }

    if (col.type === 'boolean') {
      return value ? 1 : 0
    }

    return value
  }

  private deserializeRow(row: Record<string, unknown>, schema: ColumnDef[]): Record<string, unknown> {
    const defs = new Map(schema.map((c) => [c.name, c]))
    const result: Record<string, unknown> = { ...row }

    for (const [key, raw] of Object.entries(result)) {
      const col = defs.get(key)
      if (!col) {
        continue
      }

      if (col.type === 'boolean') {
        result[key] = raw === 1 || raw === '1'
      } else if (col.type === 'json' && typeof raw === 'string') {
        try {
          result[key] = JSON.parse(raw)
        } catch {
          result[key] = raw
        }
      }
    }

    return result
  }

  private formatValue(value: unknown): string {
    if (value === null || value === undefined) {
      return 'null'
    }

    if (typeof value === 'string') {
      return JSON.stringify(value)
    }

    if (typeof value === 'object') {
      return JSON.stringify(value)
    }

    return String(value)
  }

  private requiredString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${name} must be a non-empty string.`)
    }
    return value.trim()
  }

  private requiredObject(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${name} must be an object.`)
    }
    return value as Record<string, unknown>
  }

  private requiredNumber(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${name} must be a finite number.`)
    }
    return value
  }
}
