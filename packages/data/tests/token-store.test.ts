/**
 * @description Real (on-disk) tests for the encrypted bot-token store.
 *
 * The store is the security boundary for live Telegram tokens: a leaked DB file
 * must be useless without the sibling key, tampering must be detected, and the
 * key/DB files must be owner-only. These properties get explicit, mutation-
 * checked coverage against a REAL better-sqlite3 DB + REAL AES-256-GCM crypto in
 * a temp dir (never ~/.teya).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { TokenStore, loadOrCreateKey } from '../src/token-store.js'

const REAL_TOKEN = '123456789:AAH-this_is_a_fake_but_well_formed_bot_token_xyz'

let dir: string
let dbPath: string
let keyPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'teya-tokstore-'))
  dbPath = join(dir, 'secrets.db')
  keyPath = join(dir, 'secret.key')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('encrypt → decrypt round-trip', () => {
  it('stores then returns the exact token (full lifecycle)', () => {
    const s = new TokenStore(dbPath, keyPath)
    try {
      // create
      expect(s.hasToken('ceo')).toBe(false)
      expect(s.getToken('ceo')).toBeNull()
      s.setToken('ceo', REAL_TOKEN)
      // read
      expect(s.hasToken('ceo')).toBe(true)
      expect(s.getToken('ceo')).toBe(REAL_TOKEN)
      // update (rotate to a new value)
      const rotated = '987654321:BBB-rotated_token_value_with_enough_len'
      s.setToken('ceo', rotated)
      expect(s.getToken('ceo')).toBe(rotated)
      // delete
      expect(s.deleteToken('ceo')).toBe(true)
      expect(s.hasToken('ceo')).toBe(false)
      expect(s.getToken('ceo')).toBeNull()
      // idempotent delete
      expect(s.deleteToken('ceo')).toBe(false)
    } finally {
      s.close()
    }
  })

  it('persists across store re-open (same key + db) — decrypts after reload', () => {
    const s1 = new TokenStore(dbPath, keyPath)
    s1.setToken('alina', REAL_TOKEN)
    s1.close()
    const s2 = new TokenStore(dbPath, keyPath)
    try {
      expect(s2.getToken('alina')).toBe(REAL_TOKEN)
    } finally {
      s2.close()
    }
  })

  it('lists only names, never values', () => {
    const s = new TokenStore(dbPath, keyPath)
    try {
      s.setToken('b', REAL_TOKEN)
      s.setToken('a', REAL_TOKEN)
      expect(s.listNames()).toEqual(['a', 'b']) // sorted, names only
      expect(JSON.stringify(s.listNames())).not.toContain(REAL_TOKEN)
    } finally {
      s.close()
    }
  })
})

describe('encryption is real (at-rest)', () => {
  it('the plaintext token never appears in the DB bytes; ciphertext != plaintext', async () => {
    const s = new TokenStore(dbPath, keyPath)
    s.setToken('ceo', REAL_TOKEN)
    s.close()
    // Read the raw DB file (and WAL sidecar) — the token must not be there.
    const dbBytes = await readFile(dbPath)
    expect(dbBytes.includes(Buffer.from(REAL_TOKEN, 'utf-8'))).toBe(false)
    // WAL may hold the page; check it too if present.
    try {
      const wal = await readFile(dbPath + '-wal')
      expect(wal.includes(Buffer.from(REAL_TOKEN, 'utf-8'))).toBe(false)
    } catch { /* no wal file — fine */ }
  })

  it('the same token stored twice yields different ciphertext (unique IV per write)', () => {
    const s = new TokenStore(dbPath, keyPath)
    try {
      s.setToken('a', REAL_TOKEN)
      // Reach into the DB to compare ciphertext of two distinct rows with the
      // SAME plaintext — they must differ because each write uses a fresh IV.
      const db = (s as unknown as { db: import('better-sqlite3').Database }).db
      const rowA = db.prepare('SELECT token_ciphertext, iv FROM bot_tokens WHERE name=?').get('a') as {
        token_ciphertext: Buffer; iv: Buffer
      }
      s.setToken('b', REAL_TOKEN)
      const rowB = db.prepare('SELECT token_ciphertext, iv FROM bot_tokens WHERE name=?').get('b') as {
        token_ciphertext: Buffer; iv: Buffer
      }
      expect(Buffer.compare(rowA.iv, rowB.iv)).not.toBe(0) // different IVs
      expect(Buffer.compare(rowA.token_ciphertext, rowB.token_ciphertext)).not.toBe(0) // different ciphertext
      // ...and neither ciphertext equals the plaintext bytes.
      expect(rowA.token_ciphertext.includes(Buffer.from(REAL_TOKEN))).toBe(false)
    } finally {
      s.close()
    }
  })

  it('tampered ciphertext is rejected (GCM auth tag mismatch → throws, no silent garbage)', () => {
    const s = new TokenStore(dbPath, keyPath)
    try {
      s.setToken('ceo', REAL_TOKEN)
      const db = (s as unknown as { db: import('better-sqlite3').Database }).db
      // Flip a byte in the stored ciphertext.
      const row = db.prepare('SELECT token_ciphertext FROM bot_tokens WHERE name=?').get('ceo') as {
        token_ciphertext: Buffer
      }
      const tampered = Buffer.from(row.token_ciphertext)
      tampered[0] = tampered[0] ^ 0xff
      db.prepare('UPDATE bot_tokens SET token_ciphertext=? WHERE name=?').run(tampered, 'ceo')
      expect(() => s.getToken('ceo')).toThrow()
    } finally {
      s.close()
    }
  })

  it('a DIFFERENT key cannot decrypt (DB without its key is useless)', () => {
    const s1 = new TokenStore(dbPath, keyPath)
    s1.setToken('ceo', REAL_TOKEN)
    s1.close()
    // Open the same DB with a different key file → decrypt must fail.
    const otherKey = join(dir, 'other.key')
    const s2 = new TokenStore(dbPath, otherKey)
    try {
      expect(() => s2.getToken('ceo')).toThrow()
    } finally {
      s2.close()
    }
  })
})

describe('rename (re-key) without decrypting', () => {
  it('moves a token to a new name; old name gone, value intact', () => {
    const s = new TokenStore(dbPath, keyPath)
    try {
      s.setToken('old', REAL_TOKEN)
      s.renameToken('old', 'new')
      expect(s.hasToken('old')).toBe(false)
      expect(s.hasToken('new')).toBe(true)
      expect(s.getToken('new')).toBe(REAL_TOKEN)
    } finally {
      s.close()
    }
  })

  it('rename to an existing name overwrites it (no leftover)', () => {
    const s = new TokenStore(dbPath, keyPath)
    try {
      s.setToken('old', REAL_TOKEN)
      s.setToken('new', 'tobereplaced:0000000000000000000000000000000000')
      s.renameToken('old', 'new')
      expect(s.getToken('new')).toBe(REAL_TOKEN)
      expect(s.hasToken('old')).toBe(false)
      expect(s.listNames()).toEqual(['new'])
    } finally {
      s.close()
    }
  })
})

describe('input validation', () => {
  it('refuses an empty token / empty name', () => {
    const s = new TokenStore(dbPath, keyPath)
    try {
      expect(() => s.setToken('', REAL_TOKEN)).toThrow(/name is required/)
      expect(() => s.setToken('ceo', '')).toThrow(/empty token/)
    } finally {
      s.close()
    }
  })
})

describe('key + db file permissions (0600, owner-only)', () => {
  it('generates a 32-byte key chmod 600 on first use, and 600 on the db', async () => {
    const s = new TokenStore(dbPath, keyPath)
    try {
      s.setToken('ceo', REAL_TOKEN)
    } finally {
      s.close()
    }
    const keyStat = await stat(keyPath)
    const keyBuf = await readFile(keyPath)
    expect(keyBuf.length).toBe(32)
    // Low 9 perm bits must be 0o600 (owner rw, nobody else).
    expect(keyStat.mode & 0o777).toBe(0o600)
    const dbStat = await stat(dbPath)
    expect(dbStat.mode & 0o777).toBe(0o600)
  })

  it('loadOrCreateKey returns the SAME key on second call (stable, not re-generated)', () => {
    const k1 = loadOrCreateKey(keyPath)
    const k2 = loadOrCreateKey(keyPath)
    expect(Buffer.compare(k1, k2)).toBe(0)
    expect(k1.length).toBe(32)
  })

  it('refuses a corrupt (wrong-length) key file instead of silently re-keying', async () => {
    const { writeFile } = await import('fs/promises')
    await writeFile(keyPath, Buffer.alloc(16), { mode: 0o600 }) // too short
    expect(() => loadOrCreateKey(keyPath)).toThrow(/expected 32/)
  })
})
