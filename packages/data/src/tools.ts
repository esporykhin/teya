/**
 * @description Auto-generates CRUD tools from data schema (create/list/get/update/delete/count)
 */
import type { AgentDataStore } from './store.js'
import type { DataSchema, TableSchema, ColumnSchema } from './schema.js'

type DataTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  source: 'data'
  cost: {
    latency: 'instant' | 'fast' | 'slow'
    tokenCost: 'none' | 'low' | 'high'
    sideEffects: boolean
    reversible: boolean
    external: boolean
  }
  execute: (args: Record<string, unknown>) => Promise<string>
}

export function createDataTools(store: AgentDataStore, schema: DataSchema, namespace: string = 'default'): DataTool[] {
  const tools: DataTool[] = []

  // Meta-tool: always available
  tools.push({
    name: 'data:list_tables',
    description: 'List all available data tables with descriptions and record counts.',
    parameters: { type: 'object', properties: {} },
    source: 'data',
    cost: { latency: 'instant', tokenCost: 'low', sideEffects: false, reversible: true, external: false },
    execute: async () => {
      const tables = store.listTables()
      return tables.map(t => `- ${namespace}.${t.name}: ${t.description} (${t.count} records)`).join('\n') || 'No tables defined.'
    },
  })

  // CRUD tools per table
  for (const [tableName, tableDef] of Object.entries(schema.tables)) {
    const toolPrefix = `data:${namespace}.${tableName}`
    const colDescriptions = Object.entries(tableDef.columns)
      .map(([name, col]) => `${name} (${col.type}${col.required ? ', required' : ''})`)
      .join(', ')

    // CREATE
    tools.push({
      name: `${toolPrefix}:create`,
      description: `Create a new ${tableName} record. Columns: ${colDescriptions}`,
      parameters: buildCreateParams(tableDef),
      source: 'data',
      cost: { latency: 'instant', tokenCost: 'none', sideEffects: true, reversible: true, external: false },
      execute: async (args) => {
        const record = store.create(tableName, args)
        return `Created ${tableName} #${record['id']}: ${JSON.stringify(record)}`
      },
    })

    // LIST
    tools.push({
      name: `${toolPrefix}:list`,
      description: `Search/list ${tableName} records. Filter, sort, paginate.`,
      parameters: {
        type: 'object',
        properties: {
          where: { type: 'object', description: 'Filters: { field: value } or { field: { op: value } }. Ops: eq, ne, gt, gte, lt, lte, like' },
          order_by: { type: 'string', description: 'Sort field. Prefix - for DESC. e.g. "-created_at"' },
          limit: { type: 'number', description: 'Max results (default 20, max 100)' },
          offset: { type: 'number', description: 'Skip N results' },
        },
      },
      source: 'data',
      cost: { latency: 'instant', tokenCost: 'low', sideEffects: false, reversible: true, external: false },
      execute: async (args) => {
        const rows = store.list(tableName, args as { where?: Record<string, unknown>; order_by?: string; limit?: number; offset?: number })
        if (rows.length === 0) return `No ${tableName} records found.`
        return rows.map(r => JSON.stringify(r)).join('\n')
      },
    })

    // GET
    tools.push({
      name: `${toolPrefix}:get`,
      description: `Get a single ${tableName} record by ID.`,
      parameters: { type: 'object', properties: { id: { type: 'number', description: 'Record ID' } }, required: ['id'] },
      source: 'data',
      cost: { latency: 'instant', tokenCost: 'none', sideEffects: false, reversible: true, external: false },
      execute: async (args) => {
        const record = store.get(tableName, args['id'] as number)
        return record ? JSON.stringify(record) : `${tableName} #${args['id']} not found.`
      },
    })

    // UPDATE
    tools.push({
      name: `${toolPrefix}:update`,
      description: `Update a ${tableName} record. Pass id and fields to change.`,
      parameters: buildUpdateParams(tableDef),
      source: 'data',
      cost: { latency: 'instant', tokenCost: 'none', sideEffects: true, reversible: true, external: false },
      execute: async (args) => {
        const { id, ...data } = args
        const record = store.update(tableName, id as number, data)
        return record ? `Updated ${tableName} #${id}: ${JSON.stringify(record)}` : `${tableName} #${id} not found.`
      },
    })

    // DELETE
    tools.push({
      name: `${toolPrefix}:delete`,
      description: `Delete a ${tableName} record by ID.`,
      parameters: { type: 'object', properties: { id: { type: 'number', description: 'Record ID' } }, required: ['id'] },
      source: 'data',
      cost: { latency: 'instant', tokenCost: 'none', sideEffects: true, reversible: false, external: false },
      execute: async (args) => {
        return store.delete(tableName, args['id'] as number)
          ? `Deleted ${tableName} #${args['id']}`
          : `${tableName} #${args['id']} not found.`
      },
    })

    // COUNT
    tools.push({
      name: `${toolPrefix}:count`,
      description: `Count ${tableName} records, optionally filtered.`,
      parameters: { type: 'object', properties: { where: { type: 'object', description: 'Filters' } } },
      source: 'data',
      cost: { latency: 'instant', tokenCost: 'none', sideEffects: false, reversible: true, external: false },
      execute: async (args) => {
        const count = store.count(tableName, args['where'] as Record<string, unknown> | undefined)
        return `${count} ${tableName} records${args['where'] ? ' matching filter' : ''}`
      },
    })
  }

  return tools
}

function buildCreateParams(def: TableSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, col] of Object.entries(def.columns)) {
    const prop: Record<string, unknown> = { type: jsonSchemaType(col), description: col.description || name }
    if (col.values) prop['enum'] = col.values
    properties[name] = prop
    if (col.required) required.push(name)
  }
  return { type: 'object', properties, required }
}

function buildUpdateParams(def: TableSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = { id: { type: 'number', description: 'Record ID' } }
  for (const [name, col] of Object.entries(def.columns)) {
    properties[name] = { type: jsonSchemaType(col), description: col.description || name }
  }
  return { type: 'object', properties, required: ['id'] }
}

function jsonSchemaType(col: ColumnSchema): string {
  switch (col.type) {
    case 'integer': case 'relation': return 'number'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'json': return 'object'
    default: return 'string'
  }
}
