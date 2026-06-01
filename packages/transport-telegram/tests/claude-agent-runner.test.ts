/**
 * @description Tests for the claude-agent runner — the executor that turns a
 *  Telegram claude-agent bot into `claude --agent <name>` with a CONTINUOUS
 *  per-(bot,chat) session.
 *
 * Two load-bearing behaviours get mutation-checked coverage:
 *   1. buildClaudeAgentArgs: agent mode flags (--agent, no --append-system-prompt),
 *      and session continuity (first turn = --session-id, later = --resume).
 *   2. ClaudeSessionStore: the SAME chat key reuses one session id and reports
 *      isNew=false after the first call; distinct chats get distinct ids.
 */
import { describe, it, expect } from 'vitest'
import { buildClaudeAgentArgs, ClaudeSessionStore } from '../src/claude-agent-runner.js'

describe('buildClaudeAgentArgs', () => {
  // sessionId must be a canonical UUID (C-2 arg-injection guard); use a real one.
  const UUID = '11111111-1111-4111-8111-111111111111'

  it('first turn uses --session-id (NOT --resume)', () => {
    const args = buildClaudeAgentArgs({ agent: 'teya', sessionId: UUID, isNew: true })
    expect(args).toContain('--session-id')
    expect(args[args.indexOf('--session-id') + 1]).toBe(UUID)
    expect(args).not.toContain('--resume')
  })

  it('later turns use --resume (NOT --session-id)', () => {
    const args = buildClaudeAgentArgs({ agent: 'teya', sessionId: UUID, isNew: false })
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe(UUID)
    expect(args).not.toContain('--session-id')
  })

  it('emits --agent and never --append-system-prompt (persona is the prompt)', () => {
    const args = buildClaudeAgentArgs({ agent: 'solopreneuro-ceo', sessionId: UUID, isNew: true })
    expect(args[args.indexOf('--agent') + 1]).toBe('solopreneuro-ceo')
    expect(args).not.toContain('--append-system-prompt')
    expect(args).toContain('--print')
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2)).toEqual(['--output-format', 'json'])
  })

  // C-2: a non-UUID sessionId (or a flag-shaped value) must be rejected, not interpolated into argv.
  it('rejects a non-UUID sessionId (injection guard)', () => {
    expect(() => buildClaudeAgentArgs({ agent: 'teya', sessionId: 'sess-1', isNew: true })).toThrow(/must be a UUID/)
    expect(() => buildClaudeAgentArgs({ agent: 'teya', sessionId: '--inject x', isNew: true })).toThrow(/must be a UUID/)
  })

  // H-5: default scopes --add-dir to cwd; full-FS (`/`) is opt-in via addRootDir.
  it('scopes --add-dir to cwd by default; opens / only with addRootDir=true', () => {
    const scoped = buildClaudeAgentArgs({ agent: 'teya', sessionId: UUID, isNew: true, cwd: '/home/x', model: 'opus' })
    expect(scoped[scoped.indexOf('--add-dir') + 1]).toBe('/home/x')
    expect(scoped).not.toContain('/') // never the bare root by default
    expect(scoped[scoped.indexOf('--model') + 1]).toBe('opus')

    const root = buildClaudeAgentArgs({ agent: 'teya', sessionId: UUID, isNew: true, cwd: '/home/x', addRootDir: true })
    expect(root[root.indexOf('--add-dir') + 1]).toBe('/')
  })

  it('omits --add-dir entirely when addRootDir=false and no cwd', () => {
    const args = buildClaudeAgentArgs({ agent: 'teya', sessionId: UUID, isNew: true, addRootDir: false })
    expect(args).not.toContain('--add-dir')
  })

  // Reasoning effort → native `claude --effort <level>` flag (claude --help:
  // "--effort <level>  Effort level ... (low, medium, high, xhigh, max)").
  it('maps effort to --effort <level> (low/medium/high), omits the flag when unset', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      const args = buildClaudeAgentArgs({ agent: 'teya', sessionId: UUID, isNew: true, effort: level })
      expect(args).toContain('--effort')
      expect(args[args.indexOf('--effort') + 1]).toBe(level)
    }
    const none = buildClaudeAgentArgs({ agent: 'teya', sessionId: UUID, isNew: true })
    expect(none).not.toContain('--effort')
  })

  it('throws on a missing agent or sessionId', () => {
    expect(() => buildClaudeAgentArgs({ agent: '', sessionId: 's', isNew: true })).toThrow(/agent name is required/)
    expect(() => buildClaudeAgentArgs({ agent: 'x', sessionId: '', isNew: true })).toThrow(/sessionId is required/)
  })
})

describe('ClaudeSessionStore — continuous per-chat sessions', () => {
  it('first getOrCreate for a chat is new; second reuses the SAME id and is not new', () => {
    const store = new ClaudeSessionStore()
    const first = store.getOrCreate('tg:111:bteya')
    expect(first.isNew).toBe(true)
    expect(first.sessionId).toBeTruthy()

    const second = store.getOrCreate('tg:111:bteya')
    expect(second.isNew).toBe(false)
    expect(second.sessionId).toBe(first.sessionId) // continuity: one claude session
  })

  it('distinct chat keys get distinct session ids', () => {
    const store = new ClaudeSessionStore()
    const a = store.getOrCreate('tg:111:bteya')
    const b = store.getOrCreate('tg:222:bteya')
    expect(a.sessionId).not.toBe(b.sessionId)
    expect(a.isNew).toBe(true)
    expect(b.isNew).toBe(true)
  })

  it('the same bot in two chats and two bots in one chat never collide', () => {
    const store = new ClaudeSessionStore()
    const ids = new Set([
      store.getOrCreate('tg:111:bteya').sessionId,
      store.getOrCreate('tg:222:bteya').sessionId,
      store.getOrCreate('tg:111:bceo').sessionId,
    ])
    expect(ids.size).toBe(3)
  })

  it('reset() forces the next turn to start a fresh session', () => {
    const store = new ClaudeSessionStore()
    const first = store.getOrCreate('tg:111:bteya')
    expect(store.has('tg:111:bteya')).toBe(true)
    store.reset('tg:111:bteya')
    expect(store.has('tg:111:bteya')).toBe(false)
    const afterReset = store.getOrCreate('tg:111:bteya')
    expect(afterReset.isNew).toBe(true)
    expect(afterReset.sessionId).not.toBe(first.sessionId)
  })
})
