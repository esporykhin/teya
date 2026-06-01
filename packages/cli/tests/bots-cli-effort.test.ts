/**
 * @description Tests for the `teya bots` CLI effort flag parsing.
 *
 * The CLI layer's only novel logic over the (separately, fully tested) config
 * core is parseEffortFlag: it gates `--effort <value>` before any write. The
 * add → set-effort → list PERSISTENCE round-trip is covered against a real
 * temp-file write in bots-config.test.ts (addBotEntry/setBotEffort + readback);
 * here we pin the flag-validation contract the CLI relies on.
 *
 * Mutation-checked: loosen parseEffortFlag to accept anything → the invalid-case
 * tests go red.
 */
import { describe, it, expect } from 'vitest'
import { parseEffortFlag } from '../src/bots-cli.js'

describe('parseEffortFlag', () => {
  it('returns undefined when the flag is absent (caller applies the default)', () => {
    expect(parseEffortFlag(undefined)).toBeUndefined()
  })

  it('returns each valid level unchanged', () => {
    expect(parseEffortFlag('low')).toBe('low')
    expect(parseEffortFlag('medium')).toBe('medium')
    expect(parseEffortFlag('high')).toBe('high')
  })

  it('throws a helpful error on an invalid level (xhigh/typo/empty)', () => {
    expect(() => parseEffortFlag('xhigh')).toThrow(/invalid --effort "xhigh".*low, medium, high/)
    expect(() => parseEffortFlag('HIGH')).toThrow(/invalid --effort/)
    expect(() => parseEffortFlag('')).toThrow(/invalid --effort/)
  })
})
