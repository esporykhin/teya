/**
 * @description Per-message session context — sessionId + tool result store.
 *
 * Lives next to identity.ts and follows the same pattern: AsyncLocalStorage
 * makes the active session visible to leaf modules (e.g. core:tool_result_get
 * builtin) without threading args through every layer.
 *
 * Why a SECOND ALS instead of merging into IdentityContext:
 *   - Identity is about WHO is calling (owner / guest / system) — used by
 *     permissions and per-user data isolation.
 *   - Session is about WHICH conversation thread the call belongs to —
 *     used by tool result retrieval and per-route history compaction.
 *   - Different lifetimes: identity is process-wide for CLI mode, session
 *     is per-message. Mixing them complicates the API.
 *
 * The CLI message handler does:
 *
 *   await runWithIdentity(idCtx, () =>
 *     runWithSession({ sessionId, toolResults }, () =>
 *       agentLoop(...)
 *     )
 *   )
 */
import { AsyncLocalStorage } from 'async_hooks'

/**
 * Full content of one tool call's result, kept around so the agent can
 * retrieve it after the in-history copy has been compacted away.
 */
export interface ToolResultEntry {
  /** ToolCall id (assigned by the LLM provider) — used as the lookup key. */
  id: string
  toolName: string
  /** Truncated arg dump for human-readable references. */
  argsSummary: string
  /** Full content as the tool returned it (post-truncate to ~5000 chars). */
  fullContent: string
  /** ms timestamp. */
  createdAt: number
  /** How many times the agent retrieved this result via core:tool_result_get. */
  retrievedCount: number
}

export interface SessionRuntimeContext {
  sessionId: string
  /** Tool call id → full result. Per-session, populated as the agent runs. */
  toolResults: Map<string, ToolResultEntry>
}

const sessionStorage = new AsyncLocalStorage<SessionRuntimeContext>()

/** Wrap a callback so all nested code (incl. async) reads this session ctx. */
export function runWithSession<T>(ctx: SessionRuntimeContext, fn: () => T): T {
  return sessionStorage.run(ctx, fn)
}

/** Read the active session context. Undefined when no wrapper is active. */
export function getCurrentSession(): SessionRuntimeContext | undefined {
  return sessionStorage.getStore()
}
