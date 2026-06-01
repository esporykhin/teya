/**
 * @description Tests for buildClaudeCodeArgs — the argv builder shared by the
 *  claude-code provider's plain and agent paths.
 *
 * The load-bearing invariant: in AGENT mode we pass `--agent <name>` and MUST
 * NOT pass `--append-system-prompt` (the agent persona file IS the system
 * prompt; layering teya's on top corrupts it). Plain mode is the inverse.
 * Both are mutation-checked: flip the mode, the asserted flags flip.
 */
import { describe, it, expect } from 'vitest'
import { buildClaudeCodeArgs } from '../src/claude-code.js'

describe('buildClaudeCodeArgs', () => {
  it('agent mode: emits --agent and OMITS --append-system-prompt', () => {
    const args = buildClaudeCodeArgs({
      agent: 'teya',
      systemPrompt: 'you are teya from the host', // must be ignored in agent mode
      cwd: '/home/u/projects',
      skipPermissions: true,
    })
    expect(args).toContain('--agent')
    expect(args[args.indexOf('--agent') + 1]).toBe('teya')
    // The corruption guard: NO system-prompt flag when an agent is named.
    expect(args).not.toContain('--append-system-prompt')
    // Baseline flags still present.
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json'])
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/home/u/projects')
  })

  it('plain mode: emits --append-system-prompt and NO --agent', () => {
    const args = buildClaudeCodeArgs({
      systemPrompt: 'host system prompt',
      cwd: '/tmp/x',
      skipPermissions: true,
    })
    expect(args).not.toContain('--agent')
    expect(args).toContain('--append-system-prompt')
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('host system prompt')
  })

  it('passes --model when set, in both modes', () => {
    const a = buildClaudeCodeArgs({ agent: 'ceo', model: 'opus', cwd: '/x', skipPermissions: true })
    expect(a[a.indexOf('--model') + 1]).toBe('opus')
    const b = buildClaudeCodeArgs({ systemPrompt: 's', model: 'sonnet', cwd: '/x', skipPermissions: true })
    expect(b[b.indexOf('--model') + 1]).toBe('sonnet')
  })

  it('plain mode with no system prompt omits the flag', () => {
    const args = buildClaudeCodeArgs({ cwd: '/x', skipPermissions: true })
    expect(args).not.toContain('--append-system-prompt')
    expect(args).not.toContain('--agent')
  })

  it('maps effort to --effort <level> in both modes, omits it when unset', () => {
    const agentHi = buildClaudeCodeArgs({ agent: 'teya', cwd: '/x', skipPermissions: true, effort: 'high' })
    expect(agentHi[agentHi.indexOf('--effort') + 1]).toBe('high')
    const plainLow = buildClaudeCodeArgs({ systemPrompt: 's', cwd: '/x', skipPermissions: true, effort: 'low' })
    expect(plainLow[plainLow.indexOf('--effort') + 1]).toBe('low')
    const none = buildClaudeCodeArgs({ agent: 'teya', cwd: '/x', skipPermissions: true })
    expect(none).not.toContain('--effort')
  })

  it('uses --permission-mode instead of skip when skipPermissions=false', () => {
    const args = buildClaudeCodeArgs({
      agent: 'teya',
      cwd: '/x',
      skipPermissions: false,
      permissionMode: 'acceptEdits',
    })
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })
})
