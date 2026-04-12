import type { DataStore } from './data-store.js'
import type { DataStoreRegistry } from './registry.js'
import { getCurrentIdentity } from '@teya/core'

export function createDataTools(source: DataStore | DataStoreRegistry) {
  function activeStore(): DataStore {
    if ('for' in source && typeof source.for === 'function') {
      const id = getCurrentIdentity()
      return source.for(id?.scopeId || 'owner')
    }
    return source as DataStore
  }
  // Lazy proxy: every method/property goes through the active scope.
  const store = new Proxy({} as DataStore, {
    get(_t, prop) {
      const target = activeStore() as unknown as Record<string | symbol, unknown>
      const value = target[prop]
      return typeof value === 'function' ? (value as Function).bind(target) : value
    },
  })
  const dataTool = {
    name: 'core:data',
    description: `Dynamic SQLite database. Create tables, store and query structured data.

Actions:
  create_table — define a new table with custom schema (columns, types, constraints, indexes)
  insert       — add a row to a table
  upsert       — insert or update based on match columns
  update       — update rows by id or filter
  delete       — delete rows by id or filter
  list         — query rows with optional filters, sorting, pagination
  get          — fetch a single row by id
  count        — count rows optionally filtered
  schema       — discover tables and their structure
  alter_table  — add columns to existing table
  drop_table   — delete a table (owner only)
  grant        — share table access with another namespace
  transfer     — transfer table ownership
  sql          — run raw SELECT for complex queries (JOINs, aggregations)`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_table', 'insert', 'upsert', 'update', 'delete', 'list', 'get', 'count', 'schema', 'alter_table', 'drop_table', 'grant', 'transfer', 'sql'],
          description: 'Action to perform',
        },
        table: { type: 'string', description: 'Table name (all actions except schema without table, sql)' },
        description: { type: 'string', description: 'Table description (create_table)' },
        columns: {
          type: 'array',
          description: 'Column definitions (create_table)',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['text', 'integer', 'real', 'boolean', 'datetime', 'json'] },
              not_null: { type: 'boolean' },
              unique: { type: 'boolean' },
              default: {},
              primary_key: { type: 'boolean' },
              references: { type: 'string', description: 'e.g. other_table(id)' },
            },
            required: ['name', 'type'],
          },
        },
        indexes: {
          type: 'array',
          description: 'Index definitions (create_table)',
          items: {
            type: 'object',
            properties: {
              columns: { type: 'array', items: { type: 'string' } },
              unique: { type: 'boolean' },
            },
            required: ['columns'],
          },
        },
        data: { type: 'object', description: 'Row data (insert, upsert, update)' },
        match_on: { type: 'array', items: { type: 'string' }, description: 'Columns to match for upsert' },
        id: { type: 'number', description: 'Row id (get, update, delete)' },
        where: { type: 'object', description: 'Filter conditions { field: value } (list, count, update, delete)' },
        order_by: { type: 'string', description: 'Sort field, prefix - for DESC (list)' },
        limit: { type: 'number', description: 'Max rows 1-200 (list, default 50)' },
        offset: { type: 'number', description: 'Skip N rows (list)' },
        add_columns: { type: 'array', description: 'New columns to add (alter_table)', items: { type: 'object' } },
        namespace: { type: 'string', description: 'Target namespace (grant, transfer)' },
        new_owner: { type: 'string', description: 'New owner namespace (transfer)' },
        access: { type: 'string', enum: ['read', 'write', 'none'], description: 'Access level (grant)' },
        query: { type: 'string', description: 'SELECT query (sql)' },
      },
      required: ['action'],
    },
    source: 'builtin' as const,
    cost: {
      latency: 'instant' as const,
      tokenCost: 'low' as const,
      sideEffects: true,
      reversible: true,
      external: false,
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      try {
        const action = args.action as string
        switch (action) {
          case 'create_table': return store.createTable(args)
          case 'insert': return store.insert(args)
          case 'upsert': return store.upsert(args)
          case 'update': return store.update(args)
          case 'delete': return store.delete(args)
          case 'list': return store.list(args)
          case 'get': return store.get(args)
          case 'count': return store.count(args)
          case 'schema': return store.schema(args)
          case 'alter_table': return store.alterTable(args)
          case 'drop_table': return store.dropTable(args)
          case 'grant': return store.grant(args)
          case 'transfer': return store.transfer(args)
          case 'sql': return store.sql(args)
          default: return `Unknown action: ${action}. Available: create_table, insert, upsert, update, delete, list, get, count, schema, alter_table, drop_table, grant, transfer, sql`
        }
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }

  return { dataTool }
}
