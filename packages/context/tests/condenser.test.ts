import { describe, it, expect } from 'vitest'
import { condenseMessages, estimateTokens, estimateMessagesTokens } from '../src/condenser.js'
import type { Message } from '@teya/core'

describe('Context Condenser', () => {
  it('should estimate tokens roughly', () => {
    const tokens = estimateTokens('Hello, world!')
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(20)
  })

  it('should not condense if under budget', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ]
    const result = condenseMessages(messages, 10000)
    expect(result).toHaveLength(2)
  })

  it('should truncate old tool results', () => {
    const messages: Message[] = []
    // Add many messages to exceed budget
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `Question ${i}` })
      messages.push({ role: 'tool', content: 'A'.repeat(500), name: 'core:web_fetch', toolCallId: `call_${i}` })
      messages.push({ role: 'assistant', content: `Answer ${i}` })
    }

    const result = condenseMessages(messages, 500)
    // Should have fewer tokens than original
    expect(estimateMessagesTokens(result)).toBeLessThan(estimateMessagesTokens(messages))
  })
})
