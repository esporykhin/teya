/**
 * @description Tests for the sliding-window tool result compaction.
 *
 * Pins:
 *  - Tool results within the recent window are NOT touched
 *  - Tool results older than window AND larger than minChars get compacted
 *  - Compacted results land in the session tool result store
 *  - Already-compacted results aren't re-processed
 *  - Without active session context, compaction still works (no store)
 */
import { describe, it, expect } from 'vitest'
import { applySlidingWindow } from '../src/agent-loop.js'
import { runWithSession, getCurrentSession, type ToolResultEntry } from '../src/session-context.js'
import type { Message } from '../src/types.js'

function makeAssistant(content = 'thinking...'): Message {
  return { role: 'assistant', content }
}
function makeTool(callId: string, name: string, content: string): Message {
  return { role: 'tool', content, toolCallId: callId, name }
}

describe('applySlidingWindow', () => {
  it('does not touch tool results within the recent window', () => {
    const longContent = 'x'.repeat(1500)
    const messages: Message[] = [
      { role: 'user', content: 'do thing' },
      makeAssistant(),
      makeTool('a', 'core:web', longContent), // age = 0 LLM steps backward from end
      makeAssistant(),
    ]
    const before = messages[2].content.length
    const { truncations } = applySlidingWindow(messages, { windowSize: 3, minChars: 500 })
    expect(messages[2].content.length).toBe(before)
    expect(truncations.length).toBe(0)
  })

  it('compacts tool results older than window AND > minChars', () => {
    const longContent = 'x'.repeat(2000)
    const messages: Message[] = [
      { role: 'user', content: 'do thing' },
      makeAssistant(),
      makeTool('a', 'core:web', longContent),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
    ]
    const before = messages[2].content.length
    const { truncations } = applySlidingWindow(messages, { windowSize: 3, minChars: 500 })
    expect(truncations.length).toBe(1)
    expect(truncations[0].callId).toBe('a')
    expect(truncations[0].tool).toBe('core:web')
    expect(truncations[0].originalChars).toBe(before)
    expect(truncations[0].newChars).toBeLessThan(before)
    expect(messages[2].content).toContain('[#a core:web truncated')
    expect(messages[2].content).toContain('Use core:tool_result_get(id="a")')
  })

  it('skips small results even if they are old', () => {
    const messages: Message[] = [
      { role: 'user', content: 'do thing' },
      makeAssistant(),
      makeTool('a', 'core:exec', 'short output'),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
    ]
    const before = messages[2].content
    const { truncations } = applySlidingWindow(messages, { windowSize: 3, minChars: 500 })
    expect(truncations.length).toBe(0)
    expect(messages[2].content).toBe(before)
  })

  it('does not re-process already-compacted results', () => {
    const stub = '[#a core:web truncated]\nFirst 200: ...\n[Use core:tool_result_get(id="a")]'
    const messages: Message[] = [
      { role: 'user', content: 'do thing' },
      makeAssistant(),
      makeTool('a', 'core:web', stub),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
    ]
    const { truncations } = applySlidingWindow(messages, { windowSize: 3, minChars: 500 })
    expect(truncations.length).toBe(0)
    expect(messages[2].content).toBe(stub)
  })

  it('stashes full content in session store when one is active', () => {
    const longContent = 'this is the full result content '.repeat(50)
    const messages: Message[] = [
      { role: 'user', content: 'do thing' },
      makeAssistant(),
      makeTool('call_xyz', 'core:web', longContent),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
    ]
    const store = new Map<string, ToolResultEntry>()
    runWithSession({ sessionId: 'test', toolResults: store }, () => {
      applySlidingWindow(messages, { windowSize: 3, minChars: 500 })
    })
    expect(store.has('call_xyz')).toBe(true)
    expect(store.get('call_xyz')!.fullContent).toBe(longContent)
    expect(store.get('call_xyz')!.toolName).toBe('core:web')
  })

  it('uses tool-specific summaries (exit code for core:exec)', () => {
    const execOutput = 'Some long output\nthat takes\nmany lines\n' + 'x'.repeat(1500) + '\nExit code 127'
    const messages: Message[] = [
      { role: 'user', content: 'do' },
      makeAssistant(),
      makeTool('a', 'core:exec', execOutput),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
    ]
    applySlidingWindow(messages, { windowSize: 3, minChars: 500 })
    expect(messages[2].content).toContain('exit=127')
  })

  it('uses HTTP status for core:web summaries', () => {
    const webOutput = 'HTTP 404 Not Found\n' + 'x'.repeat(1500)
    const messages: Message[] = [
      { role: 'user', content: 'do' },
      makeAssistant(),
      makeTool('a', 'core:web', webOutput),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
    ]
    applySlidingWindow(messages, { windowSize: 3, minChars: 500 })
    expect(messages[2].content).toContain('HTTP 404')
  })
})

describe('SessionRuntimeContext via runWithSession', () => {
  it('exposes the toolResults map to leaf code via getCurrentSession()', () => {
    const store = new Map<string, ToolResultEntry>()
    let observed: ReturnType<typeof getCurrentSession>
    runWithSession({ sessionId: 'test', toolResults: store }, () => {
      store.set('a', {
        id: 'a',
        toolName: 'core:web',
        argsSummary: 'fetch x',
        fullContent: 'full content',
        createdAt: Date.now(),
        retrievedCount: 0,
      })
      observed = getCurrentSession()
    })
    expect(observed).toBeDefined()
    expect(observed!.sessionId).toBe('test')
    expect(observed!.toolResults.get('a')!.fullContent).toBe('full content')
  })

  it('returns undefined outside the wrapped scope', () => {
    expect(getCurrentSession()).toBeUndefined()
  })
})
