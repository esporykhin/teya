/**
 * @description Context budget calculator — profiles and token allocation by model size
 */
export type ContextProfile = 'minimal' | 'standard' | 'large'

export function getContextProfile(maxContextTokens: number): ContextProfile {
  if (maxContextTokens < 16000) return 'minimal'
  if (maxContextTokens < 65000) return 'standard'
  return 'large'
}

export function calculateBudget(capabilities: { maxContextTokens: number; maxOutputTokens: number }): {
  effectiveBudget: number
  condenserThreshold: number
  systemPromptBudget: number
  conversationBudget: number
  outputReserve: number
} {
  const outputReserve = capabilities.maxOutputTokens + 500 // safety margin
  const effectiveBudget = capabilities.maxContextTokens - outputReserve
  const condenserThreshold = Math.floor(effectiveBudget * 0.75)
  const systemPromptBudget = Math.floor(effectiveBudget * 0.3)
  const conversationBudget = Math.floor(effectiveBudget * 0.5)
  return { effectiveBudget, condenserThreshold, systemPromptBudget, conversationBudget, outputReserve }
}
