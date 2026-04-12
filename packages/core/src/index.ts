/**
 * @description Re-exports all core modules
 */
export * from "./types.js";
export { buildSystemPrompt, type SystemPromptOptions } from './system-prompt.js'
export { agentLoop, applySlidingWindow, type AgentLoopDeps, type SlidingCompactionResult } from './agent-loop.js'
export { PermissionEngine, sanitizeExternalResult, checkDLP, type PermissionConfig, type PermissionRule, type PermissionMode, type PermissionResult } from './security.js'
export {
  runWithIdentity,
  getCurrentIdentity,
  isOwnerCall,
  scopeIdFor,
  makeIdentityContext,
  OWNER_DEFAULT,
  type Identity,
  type IdentityContext,
  type ScopeId,
} from './identity.js'
export {
  runWithSession,
  getCurrentSession,
  type SessionRuntimeContext,
  type ToolResultEntry,
} from './session-context.js'
