/**
 * @description Tests for buildCodexArgs — the argv builder for `codex exec`.
 *
 * Load-bearing mapping under test: reasoning effort → codex's
 * `-c model_reasoning_effort="<level>"` config override (codex natively supports
 * low/medium/high, so it's a direct map). Also pins the sandbox/full-auto/model
 * argv so a regression in one doesn't slip past behind the effort assertions.
 * Mutation-checked: drop the `-c` push and the effort tests go red.
 */
import { describe, it, expect } from 'vitest'
import { buildCodexArgs } from '../src/codex.js'

describe('buildCodexArgs — reasoning effort', () => {
  it('maps each effort to -c model_reasoning_effort="<level>"', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      const args = buildCodexArgs({ cwd: '/x', sandbox: 'workspace-write', fullAuto: true, effort: level })
      const i = args.indexOf('-c')
      expect(i).toBeGreaterThanOrEqual(0)
      expect(args[i + 1]).toBe(`model_reasoning_effort="${level}"`)
    }
  })

  it('omits the effort override entirely when effort is unset', () => {
    const args = buildCodexArgs({ cwd: '/x', sandbox: 'workspace-write', fullAuto: true })
    expect(args).not.toContain('-c')
    expect(args.join(' ')).not.toContain('model_reasoning_effort')
  })

  it('keeps the baseline exec argv (json + skip-git + full-auto + cwd + model)', () => {
    const args = buildCodexArgs({ model: 'gpt-5.4', cwd: '/proj', sandbox: 'workspace-write', fullAuto: true, effort: 'high' })
    expect(args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check'])
    expect(args).toContain('--full-auto')
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.4')
    expect(args[args.indexOf('-C') + 1]).toBe('/proj')
  })

  it('danger-full-access bypasses approvals instead of --full-auto, still maps effort', () => {
    const args = buildCodexArgs({ cwd: '/x', sandbox: 'danger-full-access', fullAuto: false, effort: 'low' })
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(args).not.toContain('--full-auto')
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="low"')
  })
})
