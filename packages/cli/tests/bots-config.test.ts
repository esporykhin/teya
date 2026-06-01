/**
 * @description Tests for the `teya bots` config-mutation core
 *   (add / set-agent / remove + atomic write + agent resolution).
 *
 * These functions decide "which token → which bot → which agent" and rewrite
 * the live ~/.teya/telegram.json the launchd multiplexer reads on reload. Two
 * production-down failure modes get explicit, mutation-checked coverage:
 *   1. a duplicate token_env (two pollers on one token ⇒ Telegram 409), and
 *   2. clobbering owner-authored keys (_comment / _cutover_pending) on rewrite.
 * The happy path is a full lifecycle: add → list sees it → set-agent changes
 * it → remove → list is empty, with field-level assertions at every step.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readRawConfig,
  writeRawConfig,
  addBotEntry,
  setBotAgent,
  setBotEffort,
  removeBotEntry,
  resolveAgentDir,
  resolveEffort,
  isBotEffort,
  DEFAULT_EFFORT,
  listAgents,
  agentFilesIn,
  type RawTelegramConfig,
} from '../src/telegram-multi-config.js'

let dir: string
let cfgPath: string
let agentsDir: string

/** Create an agent persona folder (a dir holding the given files). */
async function makeAgent(name: string, files: string[] = ['SOUL.md']): Promise<string> {
  const d = join(agentsDir, name)
  await mkdir(d, { recursive: true })
  for (const f of files) await writeFile(join(d, f), `# ${name} ${f}\n`, 'utf-8')
  return d
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'teya-bots-'))
  cfgPath = join(dir, 'telegram.json')
  agentsDir = join(dir, 'agents')
  await mkdir(agentsDir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ─── readRawConfig ───────────────────────────────────────────────────────────

describe('readRawConfig', () => {
  it('returns an empty bots array when the file does not exist', async () => {
    const cfg = await readRawConfig(cfgPath)
    expect(cfg).toEqual({ bots: [] })
  })

  it('refuses to read (would-overwrite) malformed JSON', async () => {
    await writeFile(cfgPath, '{ not json', 'utf-8')
    await expect(readRawConfig(cfgPath)).rejects.toThrow(/Invalid JSON/)
  })

  it('preserves unknown top-level keys', async () => {
    await writeFile(cfgPath, JSON.stringify({ bots: [], _comment: 'hi', _cutover_pending: { x: 1 } }), 'utf-8')
    const cfg = await readRawConfig(cfgPath)
    expect(cfg._comment).toBe('hi')
    expect(cfg._cutover_pending).toEqual({ x: 1 })
  })
})

// ─── full lifecycle: add → list → set-agent → remove ─────────────────────────

describe('bot binding lifecycle', () => {
  it('add → readback sees it → set-agent changes it → remove → empty', async () => {
    const agentA = await makeAgent('agent-a')
    const agentB = await makeAgent('agent-b')

    // ── add ──────────────────────────────────────────────────────────────
    let cfg = await readRawConfig(cfgPath)
    addBotEntry(cfg, { name: 'ceo', token_env: 'CEO_TOK', agentDir: agentA, allowed_chat_ids: [42], model: 'opus' })
    await writeRawConfig(cfg, cfgPath)

    // readback must see the exact entry
    cfg = await readRawConfig(cfgPath)
    expect(cfg.bots).toHaveLength(1)
    expect(cfg.bots![0]).toEqual({
      name: 'ceo',
      token_env: 'CEO_TOK',
      agentDir: agentA,
      allowed_chat_ids: [42],
      model: 'opus',
    })

    // ── set-agent (re-point to agent-b, drop the model) ──────────────────
    setBotAgent(cfg, 'ceo', { agentDir: agentB }, '')
    await writeRawConfig(cfg, cfgPath)
    cfg = await readRawConfig(cfgPath)
    expect(cfg.bots![0].agentDir).toBe(agentB)
    expect(cfg.bots![0].model).toBeUndefined()
    // unrelated fields untouched
    expect(cfg.bots![0].token_env).toBe('CEO_TOK')
    expect(cfg.bots![0].allowed_chat_ids).toEqual([42])

    // ── remove ───────────────────────────────────────────────────────────
    removeBotEntry(cfg, 'ceo')
    await writeRawConfig(cfg, cfgPath)
    cfg = await readRawConfig(cfgPath)
    expect(cfg.bots).toEqual([])
  })

  it('add without optional fields omits allowed_chat_ids and model', async () => {
    const a = await makeAgent('a')
    const cfg = await readRawConfig(cfgPath)
    addBotEntry(cfg, { name: 'plain', token_env: 'T', agentDir: a })
    expect(cfg.bots![0]).toEqual({ name: 'plain', token_env: 'T', agentDir: a })
    expect('allowed_chat_ids' in cfg.bots![0]).toBe(false)
    expect('model' in cfg.bots![0]).toBe(false)
  })
})

// ─── claude-agent mode entries ───────────────────────────────────────────────

describe('addBotEntry — claude-agent mode', () => {
  it('writes agent/cwd/stranger_reply and OMITS agentDir', async () => {
    const cfg = await readRawConfig(cfgPath)
    addBotEntry(cfg, {
      name: 'ceo',
      token_env: 'CEO_TOK',
      claudeAgent: { agent: 'solopreneuro-ceo', cwd: '/projects/solopreneuro', stranger_reply: 'нет' },
      allowed_chat_ids: [42],
      model: 'opus',
    })
    await writeRawConfig(cfg, cfgPath)
    const back = await readRawConfig(cfgPath)
    expect(back.bots![0]).toEqual({
      name: 'ceo',
      token_env: 'CEO_TOK',
      agent: 'solopreneuro-ceo',
      cwd: '/projects/solopreneuro',
      stranger_reply: 'нет',
      allowed_chat_ids: [42],
      model: 'opus',
    })
    expect('agentDir' in back.bots![0]).toBe(false)
  })

  it('rejects setting both claude agent and teya agentDir', async () => {
    const cfg = await readRawConfig(cfgPath)
    expect(() => addBotEntry(cfg, {
      name: 'x',
      token_env: 'X',
      agentDir: '/a',
      claudeAgent: { agent: 'teya' },
    })).toThrow(/not both/)
    expect(cfg.bots).toHaveLength(0)
  })

  it('rejects setting neither claude agent nor teya agentDir', async () => {
    const cfg = await readRawConfig(cfgPath)
    expect(() => addBotEntry(cfg, { name: 'x', token_env: 'X' }))
      .toThrow(/Missing agent/)
    expect(cfg.bots).toHaveLength(0)
  })

  it('still 409-guards a duplicate token across modes', async () => {
    const cfg = await readRawConfig(cfgPath)
    addBotEntry(cfg, { name: 'ceo', token_env: 'SHARED', claudeAgent: { agent: 'ceo' } })
    expect(() => addBotEntry(cfg, { name: 'teya', token_env: 'SHARED', agentDir: '/a' }))
      .toThrow(/already bound|409/i)
    expect(cfg.bots).toHaveLength(1)
  })
})

// ─── dup-guards (409 protection) ─────────────────────────────────────────────

describe('add uniqueness guards', () => {
  function seeded(): RawTelegramConfig {
    return { bots: [{ name: 'teya', token_env: 'TEYA_TOK', agentDir: '/x' }] }
  }

  it('rejects a duplicate token_env (would 409)', () => {
    const cfg = seeded()
    expect(() => addBotEntry(cfg, { name: 'other', token_env: 'TEYA_TOK', agentDir: '/y' }))
      .toThrow(/already bound|one poller|409/i)
    // and the config is unchanged — no partial write
    expect(cfg.bots).toHaveLength(1)
  })

  it('rejects a duplicate name', () => {
    const cfg = seeded()
    expect(() => addBotEntry(cfg, { name: 'teya', token_env: 'OTHER_TOK', agentDir: '/y' }))
      .toThrow(/already exists/i)
    expect(cfg.bots).toHaveLength(1)
  })

  it('allows a distinct name + token', () => {
    const cfg = seeded()
    addBotEntry(cfg, { name: 'ceo', token_env: 'CEO_TOK', agentDir: '/z' })
    expect(cfg.bots!.map((b) => b.name)).toEqual(['teya', 'ceo'])
  })
})

// ─── set-agent / remove error paths ──────────────────────────────────────────

describe('set-agent / remove on missing bot', () => {
  it('set-agent throws for an unknown bot name', () => {
    const cfg: RawTelegramConfig = { bots: [] }
    expect(() => setBotAgent(cfg, 'ghost', '/x')).toThrow(/No bot named "ghost"/)
  })
  it('remove throws for an unknown bot name', () => {
    const cfg: RawTelegramConfig = { bots: [] }
    expect(() => removeBotEntry(cfg, 'ghost')).toThrow(/No bot named "ghost"/)
  })
})

// ─── unknown-key preservation through a real write ───────────────────────────

describe('atomic write preserves unknown keys', () => {
  it('keeps _comment and _cutover_pending across an add+write round-trip', async () => {
    const cutover = {
      _note: 'do not touch',
      entry: { name: 'solopreneuro-ceo', token_env: 'SOLOPRENEURO_TG_BOT_TOKEN', agentDir: '/agents/ceo' },
    }
    await writeFile(
      cfgPath,
      JSON.stringify({ _comment: 'hand-written', bots: [{ name: 'teya', token_env: 'TEYA_TOK', agentDir: '/a' }], _cutover_pending: cutover }),
      'utf-8',
    )

    const cfg = await readRawConfig(cfgPath)
    addBotEntry(cfg, { name: 'ceo', token_env: 'CEO_TOK', agentDir: '/b' })
    await writeRawConfig(cfg, cfgPath)

    // Re-read from disk as RAW text — the owner's keys must survive verbatim.
    const onDisk = JSON.parse(await readFile(cfgPath, 'utf-8'))
    expect(onDisk._comment).toBe('hand-written')
    expect(onDisk._cutover_pending).toEqual(cutover)
    expect(onDisk.bots).toHaveLength(2)
    expect(onDisk.bots.map((b: { name: string }) => b.name)).toEqual(['teya', 'ceo'])
  })

  it('writeRawConfig is atomic — leaves no temp files behind', async () => {
    const cfg: RawTelegramConfig = { bots: [{ name: 'teya', token_env: 'T', agentDir: '/a' }] }
    await writeRawConfig(cfg, cfgPath)
    const { readdir } = await import('fs/promises')
    const files = await readdir(dir)
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([])
    expect(files).toContain('telegram.json')
  })
})

// ─── reasoning effort ────────────────────────────────────────────────────────
//
// effort is a per-bot reasoning level. The load-bearing rules:
//   1. ABSENT ⇒ "medium" (DEFAULT_EFFORT) — never undefined, never a throw.
//   2. INVALID ⇒ a loud, user-facing error (a typo must not silently degrade).
//   3. add/set-effort round-trip: "medium" is implied by absence (not persisted);
//      low/high are written verbatim and read back.

describe('resolveEffort — default + validation', () => {
  it('defaults to "medium" when absent (undefined/null)', () => {
    expect(resolveEffort(undefined)).toBe('medium')
    expect(resolveEffort(null)).toBe('medium')
    expect(DEFAULT_EFFORT).toBe('medium')
  })

  it('passes through each valid level unchanged', () => {
    expect(resolveEffort('low')).toBe('low')
    expect(resolveEffort('medium')).toBe('medium')
    expect(resolveEffort('high')).toBe('high')
  })

  it('throws on an invalid level (typo guard), naming the bot', () => {
    expect(() => resolveEffort('xhigh', 'ceo')).toThrow(/ceo.*invalid effort.*low, medium, high/)
    expect(() => resolveEffort('', 'ceo')).toThrow(/invalid effort/)
    expect(() => resolveEffort(5 as unknown)).toThrow(/invalid effort/)
  })

  it('isBotEffort accepts only the three levels', () => {
    expect(isBotEffort('low')).toBe(true)
    expect(isBotEffort('medium')).toBe(true)
    expect(isBotEffort('high')).toBe(true)
    expect(isBotEffort('xhigh')).toBe(false)
    expect(isBotEffort('MEDIUM')).toBe(false)
    expect(isBotEffort(undefined)).toBe(false)
  })
})

describe('addBotEntry — effort persistence', () => {
  it('persists a non-default effort (high) verbatim', async () => {
    const cfg = await readRawConfig(cfgPath)
    addBotEntry(cfg, { name: 'ceo', token_env: 'T', agentDir: '/a', effort: 'high' })
    expect(cfg.bots![0].effort).toBe('high')
  })

  it('does NOT persist the default "medium" (absence implies it)', async () => {
    const cfg = await readRawConfig(cfgPath)
    addBotEntry(cfg, { name: 'ceo', token_env: 'T', agentDir: '/a', effort: 'medium' })
    expect('effort' in cfg.bots![0]).toBe(false)
  })

  it('omits effort entirely when not provided', async () => {
    const cfg = await readRawConfig(cfgPath)
    addBotEntry(cfg, { name: 'ceo', token_env: 'T', agentDir: '/a' })
    expect('effort' in cfg.bots![0]).toBe(false)
  })

  it('rejects an invalid effort at add time', async () => {
    const cfg = await readRawConfig(cfgPath)
    expect(() => addBotEntry(cfg, { name: 'x', token_env: 'T', agentDir: '/a', effort: 'turbo' as never }))
      .toThrow(/invalid effort/)
    expect(cfg.bots).toHaveLength(0)
  })
})

describe('setBotEffort — round-trip through a real write', () => {
  it('add(no effort) → set-effort high → readback high → reset to medium drops the key', async () => {
    // add without effort → file has no effort key
    let cfg = await readRawConfig(cfgPath)
    addBotEntry(cfg, { name: 'ceo', token_env: 'T', agentDir: '/a' })
    await writeRawConfig(cfg, cfgPath)
    cfg = await readRawConfig(cfgPath)
    expect('effort' in cfg.bots![0]).toBe(false)

    // set-effort high → persisted verbatim
    setBotEffort(cfg, 'ceo', 'high')
    await writeRawConfig(cfg, cfgPath)
    cfg = await readRawConfig(cfgPath)
    expect(cfg.bots![0].effort).toBe('high')

    // set-effort low → changes it
    setBotEffort(cfg, 'ceo', 'low')
    await writeRawConfig(cfg, cfgPath)
    cfg = await readRawConfig(cfgPath)
    expect(cfg.bots![0].effort).toBe('low')

    // set-effort medium → DROPS the key (default is implied by absence)
    setBotEffort(cfg, 'ceo', 'medium')
    await writeRawConfig(cfg, cfgPath)
    cfg = await readRawConfig(cfgPath)
    expect('effort' in cfg.bots![0]).toBe(false)
    // unrelated fields untouched
    expect(cfg.bots![0].token_env).toBe('T')
    expect(cfg.bots![0].agentDir).toBe('/a')
  })

  it('reset (effort=undefined) drops an existing effort key', async () => {
    const cfg = await readRawConfig(cfgPath)
    addBotEntry(cfg, { name: 'ceo', token_env: 'T', agentDir: '/a', effort: 'high' })
    expect(cfg.bots![0].effort).toBe('high')
    setBotEffort(cfg, 'ceo', undefined)
    expect('effort' in cfg.bots![0]).toBe(false)
  })

  it('throws for an unknown bot name', () => {
    const cfg: RawTelegramConfig = { bots: [] }
    expect(() => setBotEffort(cfg, 'ghost', 'high')).toThrow(/No bot named "ghost"/)
  })

  it('throws on an invalid effort', async () => {
    const cfg = await readRawConfig(cfgPath)
    addBotEntry(cfg, { name: 'ceo', token_env: 'T', agentDir: '/a' })
    expect(() => setBotEffort(cfg, 'ceo', 'ultra' as never)).toThrow(/invalid effort/)
  })
})

// ─── agent resolution ────────────────────────────────────────────────────────

describe('agentFilesIn / listAgents / resolveAgentDir', () => {
  it('agentFilesIn detects SOUL.md and AGENTS.md', async () => {
    const d = await makeAgent('both', ['SOUL.md', 'AGENTS.md'])
    expect((await agentFilesIn(d)).sort()).toEqual(['AGENTS.md', 'SOUL.md'])
  })

  it('agentFilesIn returns empty for a non-agent dir', async () => {
    const d = join(dir, 'not-an-agent')
    await mkdir(d, { recursive: true })
    await writeFile(join(d, 'readme.txt'), 'x', 'utf-8')
    expect(await agentFilesIn(d)).toEqual([])
  })

  it('listAgents returns only dirs with a persona file, sorted', async () => {
    await makeAgent('zeta', ['AGENTS.md'])
    await makeAgent('alpha', ['SOUL.md'])
    // a dir without persona files must be excluded
    await mkdir(join(agentsDir, 'empty-dir'), { recursive: true })
    const agents = await listAgents(agentsDir)
    expect(agents.map((a) => a.name)).toEqual(['alpha', 'zeta'])
    expect(agents[0]).toMatchObject({ name: 'alpha', files: ['SOUL.md'] })
    expect(agents[1].path).toBe(join(agentsDir, 'zeta'))
  })

  it('listAgents returns [] when the agents dir is absent', async () => {
    expect(await listAgents(join(dir, 'nope'))).toEqual([])
  })

  it('resolveAgentDir resolves a --agent name to its dir', async () => {
    const d = await makeAgent('ceo')
    expect(await resolveAgentDir({ agent: 'ceo' }, agentsDir)).toBe(d)
  })

  it('resolveAgentDir accepts an absolute --agent-dir', async () => {
    const d = await makeAgent('ceo')
    expect(await resolveAgentDir({ agentDir: d }, agentsDir)).toBe(d)
  })

  it('resolveAgentDir rejects a dir without a persona file', async () => {
    const d = join(dir, 'bare')
    await mkdir(d, { recursive: true })
    await expect(resolveAgentDir({ agentDir: d }, agentsDir)).rejects.toThrow(/no SOUL\.md or AGENTS\.md/)
  })

  it('resolveAgentDir rejects when neither or both are given', async () => {
    await expect(resolveAgentDir({}, agentsDir)).rejects.toThrow(/Missing agent/)
    await expect(resolveAgentDir({ agent: 'a', agentDir: '/x' }, agentsDir)).rejects.toThrow(/not both/)
  })
})
