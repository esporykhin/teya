/**
 * @description Per-identity DataStore registry.
 *
 * Each scope (owner / guest-tg-789) gets its own data.db file. Owner stays
 * at the legacy ~/.teya/data.db so existing tables are preserved. Guests
 * land in ~/.teya/guests/<scopeId>/data.db.
 *
 * Namespace-based access control inside DataStore still works as before
 * — but the file boundary is the actual security fence.
 */
import { join } from 'path'
import { homedir } from 'os'
import { DataStore } from './data-store.js'

const TEYA_HOME = join(homedir(), '.teya')
const OWNER_DB = join(TEYA_HOME, 'data.db')
const GUESTS_ROOT = join(TEYA_HOME, 'guests')

export class DataStoreRegistry {
  private cache = new Map<string, DataStore>()
  private mainNamespace: string

  constructor(mainNamespace: string = 'teya') {
    this.mainNamespace = mainNamespace
  }

  for(scopeId: string): DataStore {
    const cached = this.cache.get(scopeId)
    if (cached) return cached
    const path = scopeId === 'owner'
      ? OWNER_DB
      : join(GUESTS_ROOT, scopeId, 'data.db')
    // Each scope is its own DataStore instance pointing at its own file.
    // Namespace = scopeId so the DataStore's internal access control
    // doesn't accidentally treat the guest as a foreign tenant inside
    // its own DB.
    const store = new DataStore(path, scopeId, this.mainNamespace)
    this.cache.set(scopeId, store)
    return store
  }

  closeAll(): void {
    for (const s of this.cache.values()) {
      try { s.close() } catch {}
    }
    this.cache.clear()
  }
}
