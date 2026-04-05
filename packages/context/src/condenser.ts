/**
 * @description Context compression — trim tool results, remove thinking, hard truncation
 */
import type { Message } from '@teya/core'

export interface CondenserOptions {
  maxTokens: number
  // In v1, we don't have a cheap model for summarization.
  // Use simple strategies: trim tool results, truncate old messages.
}

// Rough token estimation: 1 token ≈ 4 characters (English), 1 token ≈ 2 characters (mixed/code)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 10, 0) // +10 for message overhead
}

export function condenseMessages(messages: Message[], budget: number): Message[] {
  let current = [...messages]

  // Phase 1: Trim old tool results (older than 5 messages from end)
  const toolResultCutoff = Math.max(0, current.length - 10) // keep last 10 messages untouched
  for (let i = 0; i < toolResultCutoff; i++) {
    if (current[i].role === 'tool' && current[i].content.length > 200) {
      current[i] = { ...current[i], content: current[i].content.slice(0, 200) + '\n[...truncated]' }
    }
  }
  if (estimateMessagesTokens(current) <= budget) return current

  // Phase 2: Remove thinking tool results
  current = current.filter((m, i) => {
    if (m.role === 'tool' && m.name === 'core:think' && i < toolResultCutoff) return false
    return true
  })
  if (estimateMessagesTokens(current) <= budget) return current

  // Phase 3: Hard truncation — keep system messages + last N messages
  const systemMessages = current.filter(m => m.role === 'system')
  const nonSystemMessages = current.filter(m => m.role !== 'system')

  // Binary search for how many recent messages fit
  let keepCount = nonSystemMessages.length
  while (keepCount > 5 && estimateMessagesTokens([...systemMessages, ...nonSystemMessages.slice(-keepCount)]) > budget) {
    keepCount = Math.floor(keepCount * 0.7)
  }

  const keptMessages = nonSystemMessages.slice(-keepCount)
  const truncatedSummary: Message = {
    role: 'system',
    content: `[Earlier messages truncated. ${nonSystemMessages.length - keepCount} messages removed to fit context window.]`
  }

  return [...systemMessages, truncatedSummary, ...keptMessages]
}
