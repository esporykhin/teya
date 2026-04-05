/**
 * @description YAML data schema parser — tables, columns, types, relations
 */
import { readFile } from 'fs/promises'

export interface TableSchema {
  description: string
  columns: Record<string, ColumnSchema>
}

export interface ColumnSchema {
  type: 'text' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime' | 'json' | 'enum' | 'relation'
  required?: boolean
  unique?: boolean
  index?: boolean
  default?: unknown
  description?: string
  values?: string[]    // for enum
  table?: string       // for relation (FK target)
  on_delete?: 'cascade' | 'set_null'
}

export interface DataSchema {
  tables: Record<string, TableSchema>
}

export async function loadDataSchema(schemaPath: string): Promise<DataSchema | null> {
  try {
    const content = await readFile(schemaPath, 'utf-8')
    return parseDataYaml(content)
  } catch {
    return null
  }
}

// Minimal YAML parser for our specific data schema format
// Only handles: top-level keys, nested objects, simple values
function parseDataYaml(content: string): DataSchema {
  const tables: Record<string, TableSchema> = {}
  let currentTable = ''
  let currentColumn = ''

  for (const line of content.split('\n')) {
    const trimmed = line.trimEnd()
    if (!trimmed || trimmed.startsWith('#')) continue

    const indent = line.length - line.trimStart().length
    const keyValue = trimmed.trim()

    if (indent === 0 && keyValue === 'tables:') continue

    // Table name (indent 2)
    if (indent === 2 && keyValue.endsWith(':')) {
      currentTable = keyValue.slice(0, -1).trim()
      tables[currentTable] = { description: '', columns: {} }
      currentColumn = ''
      continue
    }

    // Table properties (indent 4)
    if (indent === 4 && currentTable) {
      const colonIdx = keyValue.indexOf(':')
      if (colonIdx > 0) {
        const key = keyValue.slice(0, colonIdx).trim()
        const value = keyValue.slice(colonIdx + 1).trim()

        if (key === 'description') {
          tables[currentTable].description = value.replace(/^["']|["']$/g, '')
        } else if (key === 'columns') {
          // columns: marker
        } else {
          // Direct column with type
          currentColumn = key
          tables[currentTable].columns[key] = parseColumnDef(value)
        }
      }
    }

    // Column name (indent 6)
    if (indent === 6 && currentTable) {
      const colonIdx = keyValue.indexOf(':')
      if (colonIdx > 0) {
        const key = keyValue.slice(0, colonIdx).trim()
        const value = keyValue.slice(colonIdx + 1).trim()
        if (!value) {
          currentColumn = key
          tables[currentTable].columns[key] = { type: 'text' }
        } else {
          currentColumn = key
          tables[currentTable].columns[key] = parseColumnDef(value)
        }
      }
    }

    // Column properties (indent 8+)
    if (indent >= 8 && currentTable && currentColumn) {
      const colonIdx = keyValue.indexOf(':')
      if (colonIdx > 0) {
        const key = keyValue.slice(0, colonIdx).trim()
        let value: unknown = keyValue.slice(colonIdx + 1).trim()

        const col = tables[currentTable].columns[currentColumn]
        if (key === 'type') col.type = value as ColumnSchema['type']
        else if (key === 'required') col.required = value === 'true'
        else if (key === 'unique') col.unique = value === 'true'
        else if (key === 'index') col.index = value === 'true'
        else if (key === 'default') col.default = (value as string).replace(/^["']|["']$/g, '')
        else if (key === 'description') col.description = (value as string).replace(/^["']|["']$/g, '')
        else if (key === 'table') col.table = value as string
        else if (key === 'on_delete') col.on_delete = value as ColumnSchema['on_delete']
        else if (key === 'values') {
          // Parse [val1, val2, val3]
          const match = (value as string).match(/\[(.*)\]/)
          if (match) col.values = match[1].split(',').map((s: string) => s.trim().replace(/^["']|["']$/g, ''))
        }
      }
    }
  }

  return { tables }
}

function parseColumnDef(value: string): ColumnSchema {
  // Handle inline format like: { type: text, required: true }
  if (value.startsWith('{')) {
    try {
      const obj = JSON.parse(value.replace(/(\w+):/g, '"$1":').replace(/'/g, '"'))
      return obj as ColumnSchema
    } catch { /* fall through */ }
  }
  return { type: 'text' }
}
