/**
 * @description Assembles full LLM context: system prompt + session summary + conversation
 */
import type { Message, ToolDefinition } from '@teya/core'

export interface AssemblerInput {
  systemPrompt: string          // pre-built system prompt (from system-prompt.ts)
  toolDefinitions: ToolDefinition[]
  conversationHistory: Message[]
  sessionSummary?: string
}

export function assembleContext(input: AssemblerInput): Message[] {
  const messages: Message[] = []

  // 1. System message = systemPrompt + tool descriptions summary (if model doesn't have native tools)
  messages.push({ role: 'system', content: input.systemPrompt })

  // 2. Session summary as system message (if exists)
  if (input.sessionSummary) {
    messages.push({ role: 'system', content: `[Previous conversation summary]\n${input.sessionSummary}` })
  }

  // 3. Conversation history
  messages.push(...input.conversationHistory)

  return messages
}
