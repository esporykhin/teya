import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DataStore } from '../src/data-store.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function createContactsTable(store: DataStore): void {
  store.createTable({
    table: 'contacts',
    description: 'Contact records',
    columns: [
      { name: 'name', type: 'text', not_null: true },
      { name: 'email', type: 'text', unique: true },
      { name: 'active', type: 'boolean', default: true },
      { name: 'meta', type: 'json' },
    ],
    indexes: [{ columns: ['email'], unique: true }],
  })
}

describe('DataStore', () => {
  let store: DataStore
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'teya-data-test-'))
    store = new DataStore(join(tmpDir, 'test.db'), 'test-agent')
  })

  afterEach(() => {
    store.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('createTable — basic table creation, auto-adds id/created_at/updated_at', () => {
    const result = store.createTable({
      table: 'users',
      description: 'Users table',
      columns: [{ name: 'name', type: 'text' }],
    })

    expect(result).toContain("Table 'users' created with 1 columns.")
    const schema = store.schema({ table: 'users' })
    expect(schema).toContain('id')
    expect(schema).toContain('created_at')
    expect(schema).toContain('updated_at')
  })

  it('createTable — rejects invalid table names (starts with digit, has spaces)', () => {
    expect(() => {
      store.createTable({
        table: '1bad',
        columns: [{ name: 'name', type: 'text' }],
      })
    }).toThrow('Invalid table name')

    expect(() => {
      store.createTable({
        table: 'bad name',
        columns: [{ name: 'name', type: 'text' }],
      })
    }).toThrow('Invalid table name')
  })

  it('insert — inserts row and returns id', () => {
    createContactsTable(store)
    const result = store.insert({
      table: 'contacts',
      data: { name: 'Alice', email: 'alice@example.com', active: true },
    })

    expect(result).toMatch(/Inserted row #\d+ into 'contacts'\./)
    expect(store.count({ table: 'contacts' })).toBe("1 rows in 'contacts'.")
  })

  it('insert — error on table not found', () => {
    expect(() => {
      store.insert({ table: 'missing', data: { name: 'Alice' } })
    }).toThrow("Table 'missing' not found. Use action=schema to see available tables.")
  })

  it('upsert — inserts when row not found', () => {
    createContactsTable(store)
    const result = store.upsert({
      table: 'contacts',
      data: { name: 'Alice', email: 'alice@example.com' },
      match_on: ['email'],
    })

    expect(result).toMatch(/Inserted row #\d+ into 'contacts'\./)
    expect(store.count({ table: 'contacts' })).toBe("1 rows in 'contacts'.")
  })

  it('upsert — updates existing row when match found', () => {
    createContactsTable(store)
    store.insert({
      table: 'contacts',
      data: { name: 'Alice', email: 'alice@example.com' },
    })

    const result = store.upsert({
      table: 'contacts',
      data: { name: 'Alice Updated', email: 'alice@example.com' },
      match_on: ['email'],
    })

    expect(result).toContain("Updated row #1 in 'contacts'.")
    const got = store.get({ table: 'contacts', id: 1 })
    expect(got).toContain('Alice Updated')
  })

  it('update — updates row by id', () => {
    createContactsTable(store)
    store.insert({ table: 'contacts', data: { name: 'Alice', email: 'alice@example.com' } })

    const result = store.update({
      table: 'contacts',
      id: 1,
      data: { name: 'Alice 2' },
    })

    expect(result).toBe("Updated 1 row(s) in 'contacts'.")
    expect(store.get({ table: 'contacts', id: 1 })).toContain('Alice 2')
  })

  it('delete — deletes row by id', () => {
    createContactsTable(store)
    store.insert({ table: 'contacts', data: { name: 'Alice', email: 'alice@example.com' } })

    const result = store.delete({ table: 'contacts', id: 1 })
    expect(result).toBe("Deleted 1 row(s) from 'contacts'.")
    expect(store.count({ table: 'contacts' })).toBe("0 rows in 'contacts'.")
  })

  it('list — returns rows with filters', () => {
    createContactsTable(store)
    store.insert({ table: 'contacts', data: { name: 'Alice', email: 'alice@example.com' } })
    store.insert({ table: 'contacts', data: { name: 'Bob', email: 'bob@example.com' } })

    const result = store.list({ table: 'contacts', where: { name: 'Alice' } })
    expect(result).toContain('Alice')
    expect(result).not.toContain('Bob')
  })

  it('list — pagination (limit, offset)', () => {
    createContactsTable(store)
    store.insert({ table: 'contacts', data: { name: 'A', email: 'a@example.com' } })
    store.insert({ table: 'contacts', data: { name: 'B', email: 'b@example.com' } })
    store.insert({ table: 'contacts', data: { name: 'C', email: 'c@example.com' } })

    const result = store.list({ table: 'contacts', order_by: 'id', limit: 1, offset: 1 })
    expect(result).toContain('name="B"')
    expect(result).not.toContain('name="A"')
    expect(result).not.toContain('name="C"')
  })

  it('get — returns single row by id', () => {
    createContactsTable(store)
    store.insert({ table: 'contacts', data: { name: 'Alice', email: 'alice@example.com' } })

    const result = store.get({ table: 'contacts', id: 1 })
    expect(result).toContain("Row #1 in 'contacts':")
    expect(result).toContain('name: "Alice"')
  })

  it('count — counts rows', () => {
    createContactsTable(store)
    store.insert({ table: 'contacts', data: { name: 'Alice', email: 'alice@example.com' } })
    store.insert({ table: 'contacts', data: { name: 'Bob', email: 'bob@example.com' } })

    expect(store.count({ table: 'contacts' })).toBe("2 rows in 'contacts'.")
    expect(store.count({ table: 'contacts', where: { name: 'Alice' } })).toBe("1 rows in 'contacts' matching filter.")
  })

  it('schema without table — lists tables', () => {
    createContactsTable(store)

    const result = store.schema({})
    expect(result).toContain("Tables accessible to namespace 'test-agent':")
    expect(result).toContain('- contacts: Contact records')
  })

  it('schema with table — shows column definitions', () => {
    createContactsTable(store)

    const result = store.schema({ table: 'contacts' })
    expect(result).toContain("Table 'contacts':")
    expect(result).toContain('- name (TEXT')
    expect(result).toContain('- email (TEXT')
  })

  it('alterTable — adds new columns', () => {
    createContactsTable(store)

    const result = store.alterTable({
      table: 'contacts',
      add_columns: [{ name: 'phone', type: 'text' }],
    })

    expect(result).toBe("Added 1 column(s) to 'contacts'.")
    expect(store.schema({ table: 'contacts' })).toContain('- phone (TEXT')
  })

  it('dropTable — drops table and cleans meta', () => {
    createContactsTable(store)

    const result = store.dropTable({ table: 'contacts' })
    expect(result).toBe("Table 'contacts' dropped.")
    expect(store.schema({})).not.toContain('contacts')
    expect(store.sql({ query: "SELECT name FROM _tables WHERE name = 'contacts'" })).toBe('No results.')
  })

  it("Access control: namespace 'teya' can access all tables", () => {
    createContactsTable(store)
    store.insert({ table: 'contacts', data: { name: 'Alice', email: 'alice@example.com' } })

    const teyaStore = new DataStore(join(tmpDir, 'test.db'), 'teya')
    try {
      expect(teyaStore.schema({})).toContain('contacts')
      expect(teyaStore.list({ table: 'contacts' })).toContain('Alice')
    } finally {
      teyaStore.close()
    }
  })

  it("Access control: other namespace cannot access owner's table by default", () => {
    createContactsTable(store)

    const otherStore = new DataStore(join(tmpDir, 'test.db'), 'other-agent')
    try {
      expect(otherStore.schema({})).toContain('- none')
      expect(() => otherStore.list({ table: 'contacts' })).toThrow("Table 'contacts' not found")
    } finally {
      otherStore.close()
    }
  })

  it('Access control: grant gives access', () => {
    createContactsTable(store)
    store.insert({ table: 'contacts', data: { name: 'Alice', email: 'alice@example.com' } })
    store.grant({ table: 'contacts', namespace: 'reader', access: 'read' })

    const readerStore = new DataStore(join(tmpDir, 'test.db'), 'reader')
    try {
      expect(readerStore.schema({})).toContain('contacts')
      expect(readerStore.list({ table: 'contacts' })).toContain('Alice')
    } finally {
      readerStore.close()
    }
  })

  it('transfer — changes ownership', () => {
    createContactsTable(store)

    const result = store.transfer({ table: 'contacts', new_owner: 'new-owner' })
    expect(result).toBe("Ownership of 'contacts' transferred to 'new-owner'.")

    const newOwnerStore = new DataStore(join(tmpDir, 'test.db'), 'new-owner')
    try {
      expect(newOwnerStore.alterTable({
        table: 'contacts',
        add_columns: [{ name: 'city', type: 'text' }],
      })).toContain("Added 1 column(s) to 'contacts'.")
    } finally {
      newOwnerStore.close()
    }

    expect(() => {
      store.alterTable({
        table: 'contacts',
        add_columns: [{ name: 'country', type: 'text' }],
      })
    }).toThrow("Access denied")
  })

  it('sql — SELECT works', () => {
    createContactsTable(store)
    store.insert({ table: 'contacts', data: { name: 'Alice', email: 'alice@example.com' } })

    const result = store.sql({ query: 'SELECT id, name FROM contacts ORDER BY id ASC' })
    expect(result).toContain('Row 1:')
    expect(result).toContain('name="Alice"')
  })

  it('sql — rejects non-SELECT queries', () => {
    const result = store.sql({ query: 'DELETE FROM contacts' })
    expect(result).toBe('Only SELECT queries are allowed in sql action.')
  })
})
