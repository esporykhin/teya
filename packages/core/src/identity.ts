/**
 * @description Per-message identity context.
 *
 * Every message that reaches the agent loop carries a known identity:
 *   - owner    — admin (the human who set up Teya). Full access.
 *   - guest    — an external user who reached out via Telegram. Sandboxed.
 *   - system   — an automated trigger (cron, scheduler, sub-agent task).
 *   - anonymous — fallback when transport can't tell who's writing.
 *
 * Identity is propagated through the call stack via AsyncLocalStorage so
 * leaf modules (memory tool, permission engine) can read it without
 * threading it through every function signature. This is the idiomatic
 * Node.js pattern for request-scoped data.
 *
 * Two things are derived from identity:
 *   1. scopeId   — a stable filesystem-safe id used to isolate per-user
 *                  knowledge graphs ("owner", "tg-789012", "system").
 *   2. trust     — what the permission engine allows. Owner gets full
 *                  access; guests are restricted to safe read-only tools.
 *
 * Privacy guarantee: a guest's session reads/writes ONLY its own
 * scopeId.db. There is no shared knowledge graph between scopes. The
 * isolation is enforced at the database-file level, not by query
 * filtering, so it's impossible to leak by forgetting a WHERE clause.
 */
import { AsyncLocalStorage } from 'async_hooks'

export type Identity =
  | { kind: 'owner'; label: string }
  | {
      kind: 'guest'
      /** Stable per-transport user id (e.g. Telegram numeric id). */
      userId: string
      displayName?: string
      username?: string
      transport: string
    }
  | { kind: 'system'; reason: string }
  | { kind: 'anonymous' }

/** "owner" | "guest:tg:<id>" | "system:<reason>" | "anonymous" */
export type ScopeId = string

export interface IdentityContext {
  identity: Identity
  scopeId: ScopeId
  /** True if the identity is fully trusted (owner) — full tool access. */
  isOwner: boolean
}

const identityStorage = new AsyncLocalStorage<IdentityContext>()

/** Wrap a callback so all nested code (incl. async) reads this identity. */
export function runWithIdentity<T>(ctx: IdentityContext, fn: () => T): T {
  return identityStorage.run(ctx, fn)
}

/**
 * Read the current identity context. Returns undefined when called from
 * code that wasn't entered through runWithIdentity — leaf modules should
 * fall back to a safe default in that case (most likely: deny dangerous
 * operations and use the 'anonymous' scope for reads).
 */
export function getCurrentIdentity(): IdentityContext | undefined {
  return identityStorage.getStore()
}

/** Convenience — true when the current call stack is owner-trusted. */
export function isOwnerCall(): boolean {
  return identityStorage.getStore()?.isOwner === true
}

/** Build a stable, filesystem-safe scope id from an identity. */
export function scopeIdFor(identity: Identity): ScopeId {
  switch (identity.kind) {
    case 'owner':
      return 'owner'
    case 'guest':
      // Sanitise transport so it can't escape the directory.
      return `guest-${identity.transport.replace(/[^a-z0-9-]/gi, '')}-${identity.userId}`
    case 'system':
      return `system-${identity.reason.replace(/[^a-z0-9-]/gi, '')}`
    case 'anonymous':
      return 'anonymous'
  }
}

/** Build a complete IdentityContext from an Identity. */
export function makeIdentityContext(identity: Identity): IdentityContext {
  return {
    identity,
    scopeId: scopeIdFor(identity),
    isOwner: identity.kind === 'owner',
  }
}

/** Default identity for unattributed calls (CLI mode without resolution, eval suites, etc). */
export const OWNER_DEFAULT: IdentityContext = makeIdentityContext({
  kind: 'owner',
  label: 'admin',
})
