import { describe, it, expect } from 'vitest'
import { agentLoop } from '../src/agent-loop.js'
import { createMockProvider } from './helpers/mock-provider.js'
import { createToolRegistry, registerBuiltins } from '@teya/tools'

describe('Agent Loop', () => {
  it('should respond to a simple message', async () => {
    const provider = createMockProvider([
      { content: 'Hello! I am Teya.' }
    ])
    const toolRegistry = createToolRegistry()
    registerBuiltins(toolRegistry)

    const events = []
    for await (const event of agentLoop(
      { provider, toolRegistry, systemPrompt: 'You are helpful.', config: {} },
      'Hi',
      []
    )) {
      events.push(event)
    }

    const response = events.find(e => e.type === 'response')
    expect(response).toBeDefined()
    expect((response as { type: 'response'; content: string })?.content).toBe('Hello! I am Teya.')
    expect(events.some(e => e.type === 'thinking_start')).toBe(true)
    expect(events.some(e => e.type === 'thinking_end')).toBe(true)
  })

  it('should execute tool calls', async () => {
    const provider = createMockProvider([
      { content: '', toolCalls: [{ id: 'call_1', name: 'core:think', args: { thought: 'Testing...' } }] },
      { content: 'Done thinking.' }
    ])
    const toolRegistry = createToolRegistry()
    registerBuiltins(toolRegistry)

    const events = []
    for await (const event of agentLoop(
      { provider, toolRegistry, systemPrompt: 'You are helpful.', config: {} },
      'Think about something',
      []
    )) {
      events.push(event)
    }

    expect(events.some(e => e.type === 'tool_start' && (e as { type: 'tool_start'; tool: string }).tool === 'core:think')).toBe(true)
    expect(events.some(e => e.type === 'tool_result')).toBe(true)
    expect((events.find(e => e.type === 'response') as { type: 'response'; content: string } | undefined)?.content).toBe('Done thinking.')
  })

  it('should handle tool not found', async () => {
    const provider = createMockProvider([
      { content: '', toolCalls: [{ id: 'call_1', name: 'nonexistent:tool', args: {} }] },
      { content: 'OK, that tool was not found.' }
    ])
    const toolRegistry = createToolRegistry()
    registerBuiltins(toolRegistry)

    const events = []
    for await (const event of agentLoop(
      { provider, toolRegistry, systemPrompt: 'You are helpful.', config: {} },
      'Use a fake tool',
      []
    )) {
      events.push(event)
    }

    expect(events.some(e => e.type === 'tool_not_found')).toBe(true)
  })

  it('should respect cancellation', async () => {
    const provider = createMockProvider([
      { content: 'Should not see this' }
    ])
    const toolRegistry = createToolRegistry()
    const controller = new AbortController()
    controller.abort() // Pre-abort

    const events = []
    for await (const event of agentLoop(
      { provider, toolRegistry, systemPrompt: 'Test', config: {} },
      'Hi',
      [],
      controller.signal
    )) {
      events.push(event)
    }

    expect(events.some(e => e.type === 'cancelled')).toBe(true)
    expect(events.some(e => e.type === 'response')).toBe(false)
  })

  it('should stop at max turns', async () => {
    // Provider always returns tool calls — would loop forever
    const provider = createMockProvider([
      { content: '', toolCalls: [{ id: 'call_1', name: 'core:think', args: { thought: 'loop' } }] },
    ])
    const toolRegistry = createToolRegistry()
    registerBuiltins(toolRegistry)

    const events = []
    for await (const event of agentLoop(
      { provider, toolRegistry, systemPrompt: 'Test', config: { maxTurns: 3 } },
      'Loop forever',
      []
    )) {
      events.push(event)
    }

    expect(events.some(e => e.type === 'max_turns_reached')).toBe(true)
  })
})
