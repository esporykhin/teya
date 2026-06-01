/**
 * @description Encrypted-at-rest store for Telegram Bot-API tokens.
 *
 *   Lets the owner enter a real bot token in the web admin instead of wiring an
 *   env var. Tokens are AES-256-GCM encrypted before they ever hit disk; the
 *   32-byte key lives in ~/.teya/secret.key (chmod 600, generated once, NEVER in
 *   the repo / config / logs). The DB itself (~/.teya/secrets.db) is chmod 600
 *   too, so even a leaked DB file is useless without the sibling key.
 *
 *   Threat model this defends:
 *     - DB file copied off-box  → ciphertext only, no key → unreadable.
 *     - Config / logs leaked    → tokens never appear there (env-NAME only).
 *     - Tamper with ciphertext  → GCM auth tag mismatch → decrypt throws.
 *
 *   API: setToken / getToken / hasToken / deleteToken / listNames.
 *
 * @exports TokenStore, SECRETS_DB_FILE, SECRET_KEY_FILE
 */
import Database from 'better-sqlite3'
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

const TEYA_HOME = join(homedir(), '.teya')
/** Default location of the encrypted token DB. chmod 600. */
export const SECRETS_DB_FILE = join(TEYA_HOME, 'secrets.db')
/** Default location of the AES key. 32 random bytes, chmod 600, generated once. */
export const SECRET_KEY_FILE = join(TEYA_HOME, 'secret.key')

const ALGO = 'aes-256-gcm'
const KEY_LEN = 32 // AES-256
const IV_LEN = 12 // 96-bit nonce, the GCM standard
const TAG_LEN = 16 // 128-bit auth tag

/**
 * Load the AES-256 key from `keyPath`, generating it on first use. The freshly
 * generated key is written with mode 0600 (owner read/write only) so it never
 * sits world-readable even for a moment. Returns exactly 32 bytes or throws if
 * an existing key file is the wrong length (corrupt / truncated — refuse to
 * silently re-key, which would orphan every stored ciphertext).
 */
export function loadOrCreateKey(keyPath = SECRET_KEY_FILE): Buffer {
  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath)
    if (key.length !== KEY_LEN) {
      throw new Error(
        `Secret key at ${keyPath} is ${key.length} bytes, expected ${KEY_LEN}. ` +
          `Refusing to use it (would corrupt every stored token). Fix or remove it by hand.`,
      )
    }
    // Best-effort: tighten perms even on a pre-existing key.
    try { chmodSync(keyPath, 0o600) } catch { /* non-fatal */ }
    return key
  }
  mkdirSync(dirname(keyPath), { recursive: true })
  const key = randomBytes(KEY_LEN)
  // Write with restrictive mode from the start (mode arg applies on create).
  writeFileSync(keyPath, key, { mode: 0o600 })
  // chmod again in case a permissive umask widened the create mode.
  try { chmodSync(keyPath, 0o600) } catch { /* non-fatal */ }
  return key
}

interface TokenRow {
  name: string
  token_ciphertext: Buffer
  iv: Buffer
  tag: Buffer
  created_at: string
}

/**
 * SQLite-backed, AES-256-GCM-encrypted store of bot tokens keyed by bot name.
 * One row per bot: `(name, ciphertext, iv, tag, created_at)`. Each write gets a
 * fresh random IV so identical tokens never produce identical ciphertext, and
 * the GCM tag is verified on read so any tampering throws instead of returning
 * garbage. The DB file is chmod 600 on open.
 */
export class TokenStore {
  private db: Database.Database
  private key: Buffer

  constructor(dbPath = SECRETS_DB_FILE, keyPath = SECRET_KEY_FILE) {
    this.key = loadOrCreateKey(keyPath)
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_tokens (
        name TEXT PRIMARY KEY,
        token_ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    // Lock the DB file down to the owner. WAL sidecar files inherit perms from
    // the main file's directory on most platforms; we tighten what we own.
    try { chmodSync(dbPath, 0o600) } catch { /* non-fatal — e.g. tmpfs */ }
  }

  /** Encrypt `token` under the store key with a fresh random IV. */
  private encrypt(token: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
    const iv = randomBytes(IV_LEN)
    const cipher = createCipheriv(ALGO, this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(token, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return { ciphertext, iv, tag }
  }

  /** Decrypt a stored row, verifying the GCM tag (throws on tamper/wrong key). */
  private decrypt(row: TokenRow): string {
    const decipher = createDecipheriv(ALGO, this.key, row.iv)
    decipher.setAuthTag(row.tag)
    const plain = Buffer.concat([decipher.update(row.token_ciphertext), decipher.final()])
    return plain.toString('utf-8')
  }

  /**
   * Store (or replace) the token for `name`. The plaintext is encrypted before
   * it touches disk — the DB never sees the raw token. Upsert semantics: saving
   * again rotates the secret (new IV + ciphertext).
   */
  setToken(name: string, token: string): void {
    if (!name) throw new Error('Bot name is required to store a token.')
    if (!token) throw new Error('Refusing to store an empty token.')
    const { ciphertext, iv, tag } = this.encrypt(token)
    this.db
      .prepare(
        `INSERT INTO bot_tokens (name, token_ciphertext, iv, tag, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(name) DO UPDATE SET
           token_ciphertext = excluded.token_ciphertext,
           iv = excluded.iv,
           tag = excluded.tag,
           created_at = excluded.created_at`,
      )
      .run(name, ciphertext, iv, tag)
  }

  /** Return the decrypted token for `name`, or null if there's no row. */
  getToken(name: string): string | null {
    const row = this.db
      .prepare('SELECT name, token_ciphertext, iv, tag, created_at FROM bot_tokens WHERE name = ?')
      .get(name) as TokenRow | undefined
    if (!row) return null
    return this.decrypt(row)
  }

  /** True iff a token is stored for `name` (no decryption — boolean only). */
  hasToken(name: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM bot_tokens WHERE name = ?').get(name)
    return !!row
  }

  /**
   * Move a stored token from `oldName` to `newName` WITHOUT decrypting it — the
   * ciphertext/iv/tag row is re-keyed in place, so the plaintext never leaves
   * the store. No-op if `oldName` has no row. Overwrites any row at `newName`.
   */
  renameToken(oldName: string, newName: string): void {
    if (oldName === newName) return
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM bot_tokens WHERE name = ?').run(newName)
      this.db.prepare('UPDATE bot_tokens SET name = ? WHERE name = ?').run(newName, oldName)
    })
    tx()
  }

  /** Remove the token for `name`. Returns true if a row was deleted. */
  deleteToken(name: string): boolean {
    const r = this.db.prepare('DELETE FROM bot_tokens WHERE name = ?').run(name)
    return r.changes > 0
  }

  /** Bot names that currently have a stored token (no token values returned). */
  listNames(): string[] {
    const rows = this.db.prepare('SELECT name FROM bot_tokens ORDER BY name').all() as Array<{ name: string }>
    return rows.map((r) => r.name)
  }

  close(): void {
    this.db.close()
  }
}
