/**
 * @description Tests for the Telegram multiplexer config loader/resolver.
 *
 * This is the mapping that decides "which token → which bot → which agent".
 * Getting resolveBots wrong means: a missing secret sinks the whole gateway,
 * or two bots share a token and Telegram 409s the second poller. Both are
 * production-down failures, so they get explicit coverage.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadTelegramMultiConfig, resolveBots, isValidBotToken, type TelegramMultiConfig } from '../src/telegram-multi-config.js'

async function withTempConfig(json: unknown): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'teya-multi-cfg-'))
  const path = join(dir, 'telegram.json')
  await writeFile(path, typeof json === 'string' ? json : JSON.stringify(json), 'utf-8')
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('loadTelegramMultiConfig', () => {
  it('loads a valid config and preserves bot fields', async () => {
    const { path, cleanup } = await withTempConfig({
      bots: [
        { name: 'teya', token_env: 'A', agentDir: '/x', allowed_chat_ids: [1, 2], model: 'm1' },
      ],
    })
    try {
      const cfg = await loadTelegramMultiConfig(path)
      expect(cfg.bots).toHaveLength(1)
      expect(cfg.bots[0]).toMatchObject({
        name: 'teya',
        token_env: 'A',
        agentDir: '/x',
        allowed_chat_ids: [1, 2],
        model: 'm1',
      })
    } finally {
      await cleanup()
    }
  })

  it('throws a helpful error when the file is missing', async () => {
    await expect(loadTelegramMultiConfig('/no/such/teya-telegram.json'))
      .rejects.toThrow(/not found/)
  })

  it('throws on malformed JSON', async () => {
    const { path, cleanup } = await withTempConfig('{ not valid json ')
    try {
      await expect(loadTelegramMultiConfig(path)).rejects.toThrow(/Invalid JSON/)
    } finally {
      await cleanup()
    }
  })

  it('throws when bots array is missing or empty', async () => {
    const empty = await withTempConfig({ bots: [] })
    try {
      await expect(loadTelegramMultiConfig(empty.path)).rejects.toThrow(/non-empty "bots"/)
    } finally {
      await empty.cleanup()
    }
    const noKey = await withTempConfig({ foo: 1 })
    try {
      await expect(loadTelegramMultiConfig(noKey.path)).rejects.toThrow(/non-empty "bots"/)
    } finally {
      await noKey.cleanup()
    }
  })

  it('defaults effort to "medium" and validates an explicit value on load', async () => {
    // valid explicit effort survives the load
    const ok = await withTempConfig({ bots: [{ name: 'a', token_env: 'A', agentDir: '/x', effort: 'high' }] })
    try {
      const cfg = await loadTelegramMultiConfig(ok.path)
      expect(cfg.bots[0].effort).toBe('high')
    } finally {
      await ok.cleanup()
    }
    // a bot without effort loads fine (default applies on resolve, not stored)
    const noEffort = await withTempConfig({ bots: [{ name: 'a', token_env: 'A', agentDir: '/x' }] })
    try {
      const cfg = await loadTelegramMultiConfig(noEffort.path)
      expect(cfg.bots[0].effort).toBeUndefined()
    } finally {
      await noEffort.cleanup()
    }
    // an INVALID effort fails the load loudly (typo guard)
    const bad = await withTempConfig({ bots: [{ name: 'a', token_env: 'A', agentDir: '/x', effort: 'xhigh' }] })
    try {
      await expect(loadTelegramMultiConfig(bad.path)).rejects.toThrow(/invalid effort.*low, medium, high/)
    } finally {
      await bad.cleanup()
    }
  })

  it('throws when a bot entry lacks name', async () => {
    const noName = await withTempConfig({ bots: [{ token_env: 'A' }] })
    try {
      await expect(loadTelegramMultiConfig(noName.path)).rejects.toThrow(/missing "name"/)
    } finally {
      await noName.cleanup()
    }
  })

  it('ACCEPTS a bot without token_env (token may live in the encrypted store)', async () => {
    // token_env is optional now — a store-backed bot has no env var. Loading
    // must NOT reject; resolveBots decides (store > env) and skips only if both
    // are absent. (Mutation guard: re-adding a `!token_env` throw fails here.)
    const noToken = await withTempConfig({ bots: [{ name: 'teya', agentDir: '/x' }] })
    try {
      const cfg = await loadTelegramMultiConfig(noToken.path)
      expect(cfg.bots[0].name).toBe('teya')
      expect(cfg.bots[0].token_env).toBeUndefined()
    } finally {
      await noToken.cleanup()
    }
  })
})

describe('resolveBots', () => {
  const cfg: TelegramMultiConfig = {
    bots: [
      { name: 'teya', token_env: 'TEYA_TOK', agentDir: '/agents/teya', allowed_chat_ids: [112833890], model: 'sonnet' },
      { name: 'ceo', token_env: 'CEO_TOK', agentDir: '/agents/ceo', allowed_chat_ids: ['42'] },
    ],
  }

  it('resolves tokens from env and normalises allowed chat ids', () => {
    const resolved = resolveBots(cfg, { TEYA_TOK: 'tok-teya', CEO_TOK: 'tok-ceo' } as NodeJS.ProcessEnv, () => {})
    expect(resolved).toHaveLength(2)
    expect(resolved[0]).toMatchObject({
      name: 'teya',
      token: 'tok-teya',
      agentDir: '/agents/teya',
      allowedChatIds: [112833890],
      model: 'sonnet',
    })
    // string chat id "42" coerced to number
    expect(resolved[1]).toMatchObject({ name: 'ceo', token: 'tok-ceo', allowedChatIds: [42] })
    expect(resolved[1].model).toBeUndefined()
  })

  it('skips bots whose token env var is unset (logs, does not throw)', () => {
    const warnings: string[] = []
    const resolved = resolveBots(cfg, { TEYA_TOK: 'tok-teya' } as NodeJS.ProcessEnv, (m) => warnings.push(m))
    expect(resolved.map(r => r.name)).toEqual(['teya'])
    expect(warnings.some(w => w.includes('ceo') && w.includes('CEO_TOK'))).toBe(true)
  })

  it('throws when two bots resolve to the same token (would 409)', () => {
    expect(() => resolveBots(cfg, { TEYA_TOK: 'same', CEO_TOK: 'same' } as NodeJS.ProcessEnv, () => {}))
      .toThrow(/same token/)
  })

  it('throws when no bot can be resolved (all env vars unset)', () => {
    expect(() => resolveBots(cfg, {} as NodeJS.ProcessEnv, () => {}))
      .toThrow(/No bots could be resolved/)
  })

  it('treats an empty allowed_chat_ids as "allow everyone" (undefined)', () => {
    const open: TelegramMultiConfig = { bots: [{ name: 'teya', token_env: 'T' }] }
    const resolved = resolveBots(open, { T: 'tok' } as NodeJS.ProcessEnv, () => {})
    expect(resolved[0].allowedChatIds).toBeUndefined()
  })

  it('defaults a teya-native bot effort to "medium", and propagates an explicit one', () => {
    const c: TelegramMultiConfig = {
      bots: [
        { name: 'def', token_env: 'D', agentDir: '/a' },
        { name: 'hi', token_env: 'H', agentDir: '/b', effort: 'high' },
      ],
    }
    const resolved = resolveBots(c, { D: 'td', H: 'th' } as NodeJS.ProcessEnv, () => {})
    expect(resolved[0].effort).toBe('medium') // defaulted
    expect(resolved[1].effort).toBe('high')   // explicit
  })

  it('throws on an invalid effort while resolving (typo guard)', () => {
    const c: TelegramMultiConfig = { bots: [{ name: 'x', token_env: 'X', agentDir: '/a', effort: 'turbo' as never }] }
    expect(() => resolveBots(c, { X: 'tok' } as NodeJS.ProcessEnv, () => {}))
      .toThrow(/invalid effort/)
  })
})

describe('resolveBots — token precedence (store > env)', () => {
  it('prefers the store token over the env var when BOTH exist', () => {
    const c: TelegramMultiConfig = { bots: [{ name: 'ceo', token_env: 'CEO_TOK', agentDir: '/a' }] }
    const store = (name: string): string | null => (name === 'ceo' ? 'from-store' : null)
    const [r] = resolveBots(c, { CEO_TOK: 'from-env' } as NodeJS.ProcessEnv, () => {}, store)
    expect(r.token).toBe('from-store') // store wins (mutation guard: flip precedence → this fails)
  })

  it('falls back to env when the store has no token for the bot', () => {
    const c: TelegramMultiConfig = { bots: [{ name: 'ceo', token_env: 'CEO_TOK', agentDir: '/a' }] }
    const [r] = resolveBots(c, { CEO_TOK: 'from-env' } as NodeJS.ProcessEnv, () => {}, () => null)
    expect(r.token).toBe('from-env')
  })

  it('resolves a bot with NO token_env when the store has its token', () => {
    const c: TelegramMultiConfig = { bots: [{ name: 'storeonly', agentDir: '/a' }] }
    const store = (name: string): string | null => (name === 'storeonly' ? 'tok-store' : null)
    const resolved = resolveBots(c, {} as NodeJS.ProcessEnv, () => {}, store)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ name: 'storeonly', token: 'tok-store', agentDir: '/a' })
  })

  it('skips a bot with neither a store token nor an env token (logged)', () => {
    const c: TelegramMultiConfig = {
      bots: [
        { name: 'ok', agentDir: '/a' },                      // store-backed
        { name: 'orphan', token_env: 'MISSING', agentDir: '/b' }, // no store, env unset
      ],
    }
    const warnings: string[] = []
    const store = (name: string): string | null => (name === 'ok' ? 'tok' : null)
    const resolved = resolveBots(c, {} as NodeJS.ProcessEnv, (m) => warnings.push(m), store)
    expect(resolved.map((r) => r.name)).toEqual(['ok'])
    expect(warnings.some((w) => w.includes('orphan'))).toBe(true)
  })

  it('still 409-guards two bots that resolve to the SAME token (one from store, one from env)', () => {
    const c: TelegramMultiConfig = {
      bots: [
        { name: 'a', agentDir: '/a' },
        { name: 'b', token_env: 'B_TOK', agentDir: '/b' },
      ],
    }
    const store = (name: string): string | null => (name === 'a' ? 'shared' : null)
    expect(() => resolveBots(c, { B_TOK: 'shared' } as NodeJS.ProcessEnv, () => {}, store))
      .toThrow(/same token/)
  })
})

describe('isValidBotToken — format guard for pasted tokens', () => {
  it('accepts a well-formed <id>:<secret> token', () => {
    expect(isValidBotToken('123456789:AAH-fake_but_well_formed_token_value_xyz')).toBe(true)
  })
  it('rejects an env-var NAME, empty, and obvious junk', () => {
    expect(isValidBotToken('SOLOPRENEURO_TG_BOT_TOKEN')).toBe(false) // a NAME, not a token
    expect(isValidBotToken('')).toBe(false)
    expect(isValidBotToken('12345:short')).toBe(false) // secret too short
    expect(isValidBotToken('notanid:AAH-fake_but_well_formed_token_value_xyz')).toBe(false) // id not numeric
  })
})

describe('resolveBots — claude-agent vs teya-native routing', () => {
  it('routes an "agent" entry to claude-agent mode (claudeAgent set, agentDir unset)', () => {
    const cfg: TelegramMultiConfig = {
      bots: [{
        name: 'ceo',
        token_env: 'CEO_TOK',
        agent: 'solopreneuro-ceo',
        cwd: '/projects/solopreneuro',
        model: 'opus',
        stranger_reply: 'нет доступа',
        allowed_chat_ids: [42],
      }],
    }
    const [r] = resolveBots(cfg, { CEO_TOK: 'tok' } as NodeJS.ProcessEnv, () => {})
    expect(r.agentDir).toBeUndefined()
    expect(r.claudeAgent).toEqual({
      agent: 'solopreneuro-ceo',
      cwd: '/projects/solopreneuro',
      model: 'opus',
      strangerReply: 'нет доступа',
      addRootDir: false,
      effort: 'medium', // defaulted (not set in config)
    })
    expect(r.allowedChatIds).toEqual([42])
  })

  it('routes an "agentDir" entry to teya-native mode (agentDir set, claudeAgent unset)', () => {
    const cfg: TelegramMultiConfig = {
      bots: [{ name: 'teya', token_env: 'T', agentDir: '/agents/teya' }],
    }
    const [r] = resolveBots(cfg, { T: 'tok' } as NodeJS.ProcessEnv, () => {})
    expect(r.agentDir).toBe('/agents/teya')
    expect(r.claudeAgent).toBeUndefined()
  })

  it('defaults claude-agent cwd to HOME when omitted, expanding ~', () => {
    const cfg: TelegramMultiConfig = {
      bots: [
        { name: 'a', token_env: 'A', agent: 'teya' },
        { name: 'b', token_env: 'B', agent: 'teya', cwd: '~/projects/x' },
      ],
    }
    const env = { A: 'ta', B: 'tb', HOME: '/Users/test' } as NodeJS.ProcessEnv
    const resolved = resolveBots(cfg, env, () => {})
    expect(resolved[0].claudeAgent?.cwd).toBe('/Users/test')
    expect(resolved[1].claudeAgent?.cwd).toBe('/Users/test/projects/x')
  })

  it('throws when a bot sets BOTH agent and agentDir (ambiguous mode)', () => {
    const cfg: TelegramMultiConfig = {
      bots: [{ name: 'x', token_env: 'X', agent: 'teya', agentDir: '/agents/teya' }],
    }
    expect(() => resolveBots(cfg, { X: 'tok' } as NodeJS.ProcessEnv, () => {}))
      .toThrow(/both "agent".*and "agentDir"|pick one/i)
  })
})
