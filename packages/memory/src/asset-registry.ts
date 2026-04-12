/**
 * @description Per-identity AssetStore registry.
 *
 * Mirrors KnowledgeGraphRegistry: each scope (owner, guest-tg-789) gets its
 * own assets.db + assets/ directory under ~/.teya/guests/<scopeId>/. Owner
 * keeps the legacy paths so existing assets are preserved.
 */
import { join } from 'path'
import { homedir } from 'os'
import { AssetStore } from './assets.js'

const TEYA_HOME = join(homedir(), '.teya')
const OWNER_DB = join(TEYA_HOME, 'memory', 'assets.db')
const OWNER_DIR = join(TEYA_HOME, 'assets')
const GUESTS_ROOT = join(TEYA_HOME, 'guests')

export class AssetStoreRegistry {
  private cache = new Map<string, AssetStore>()

  for(scopeId: string): AssetStore {
    const cached = this.cache.get(scopeId)
    if (cached) return cached
    const store = scopeId === 'owner'
      ? new AssetStore(OWNER_DB, OWNER_DIR)
      : new AssetStore(
          join(GUESTS_ROOT, scopeId, 'memory', 'assets.db'),
          join(GUESTS_ROOT, scopeId, 'assets'),
        )
    this.cache.set(scopeId, store)
    return store
  }

  closeAll(): void {
    for (const store of this.cache.values()) {
      try { store.close() } catch {}
    }
    this.cache.clear()
  }
}
