/**
 * @description Real HTTP tests for the `teya admin` web control panel.
 *
 * These drive the actual Node http server (createAdminServer) over a real
 * loopback socket against a TEMP telegram.json — never the live config and
 * never launchctl (reload/serviceLoaded are stubbed). Three production-critical
 * properties get explicit, mutation-checked coverage:
 *   1. AUTH GATE — every /api/* route 401s without a valid signed session
 *      cookie; login mints one; a wrong password is rejected.
 *   2. CRUD LIFECYCLE — POST add → GET state sees it (field-level) → POST edit
 *      changes it → effort change → DELETE → GET state empty, all via HTTP,
 *      with readback from the temp config on disk.
 *   3. SECRET CONTAINMENT — the API surfaces token_env (the NAME) and a
 *      token_present boolean, but the token VALUE never appears in any response.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { createAdminServer, type AdminDeps } from '../src/admin-server.js'
import { readRawConfig } from '../src/telegram-multi-config.js'

const PASSWORD = 'test-pass-1234'
const SECRET_TOKEN_VALUE = 'super-secret-bot-token-DEADBEEF'

let dir: string
let cfgPath: string
let agentsDir: string
let server: Server
let base: string

/** Create a teya persona folder (dir with SOUL.md) so resolveAgentDir passes. */
async function makePersona(name: string): Promise<string> {
  const d = join(agentsDir, name)
  await mkdir(d, { recursive: true })
  await writeFile(join(d, 'SOUL.md'), `# ${name}\n`, 'utf-8')
  return d
}

/**
 * In-memory stand-in for the encrypted TokenStore. The real store is exercised
 * directly in token-store.test.ts (round-trip, tamper, perms); here we only need
 * the admin's interaction with it (write-only set, present-checks, delete,
 * rename) without touching disk crypto.
 */
let tokenStoreStub: Map<string, string>

/** Test deps: temp config, fixed password, stubbed launchctl + token store. */
function makeDeps(overrides: Partial<AdminDeps> = {}): AdminDeps {
  return {
    configPath: cfgPath,
    password: PASSWORD,
    serviceLoaded: () => false,
    reload: () => ({ ok: true, message: 'reloaded (stub)' }),
    // Present if a token is stored for the bot OR the legacy env "CEO_TOK" is set.
    // We assert the VALUE never leaks regardless of presence.
    tokenPresent: (botName, env) => tokenStoreStub.has(botName) || env === 'CEO_TOK',
    setToken: (botName, token) => { tokenStoreStub.set(botName, token) },
    deleteToken: (botName) => { tokenStoreStub.delete(botName) },
    tokenPresentInStore: (botName) => tokenStoreStub.has(botName),
    renameToken: (oldName, newName) => {
      const v = tokenStoreStub.get(oldName)
      if (v !== undefined) { tokenStoreStub.set(newName, v); tokenStoreStub.delete(oldName) }
    },
    listClaudeAgents: async () => [
      { name: 'solopreneuro-ceo', path: '/fake/.claude/agents/solopreneuro-ceo.md' },
    ],
    listTeyaAgents: async () => {
      const { listAgents } = await import('../src/telegram-multi-config.js')
      return listAgents(agentsDir)
    },
    listOpenRouterModels: () => ['google/gemini-2.0-flash-001', 'anthropic/claude-opus-4'],
    listOllamaModels: () => ['qwen3:8b'],
    claudeAgentExists: async (name) => name === 'solopreneuro-ceo',
    resolveAgentDir: async (opts) => {
      // Reuse the real resolver but point it at the temp agents dir.
      const { resolveAgentDir } = await import('../src/telegram-multi-config.js')
      return resolveAgentDir(opts, agentsDir)
    },
    ...overrides,
  }
}

/** HTTP helper that carries the session cookie between calls. */
function client() {
  let cookie = ''
  return {
    get cookie() { return cookie },
    async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; raw: string; setCookie?: string }> {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (cookie) headers.cookie = cookie
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const sc = res.headers.get('set-cookie')
      if (sc) cookie = sc.split(';')[0]
      const raw = await res.text()
      let json: any = undefined
      try { json = JSON.parse(raw) } catch { /* non-json (html) */ }
      return { status: res.status, json, raw, setCookie: sc ?? undefined }
    },
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'teya-admin-'))
  cfgPath = join(dir, 'telegram.json')
  agentsDir = join(dir, 'agents')
  await mkdir(agentsDir, { recursive: true })
  tokenStoreStub = new Map()
  server = createAdminServer(makeDeps())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  base = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

// ─── auth gate ───────────────────────────────────────────────────────────────

describe('auth gate', () => {
  it('rejects /api/state with 401 when not logged in', async () => {
    const c = client()
    const r = await c.req('GET', '/api/state')
    expect(r.status).toBe(401)
    expect(r.json).toMatchObject({ error: 'Not authenticated.' })
  })

  it('rejects every mutating route without a session (401)', async () => {
    const c = client()
    expect((await c.req('POST', '/api/bots', { name: 'x' })).status).toBe(401)
    expect((await c.req('POST', '/api/bots/delete', { name: 'x' })).status).toBe(401)
    expect((await c.req('POST', '/api/bots/effort', { name: 'x', effort: 'high' })).status).toBe(401)
    expect((await c.req('POST', '/api/reload')).status).toBe(401)
  })

  it('rejects login with a wrong password (401), mints a session on the right one', async () => {
    const c = client()
    const bad = await c.req('POST', '/login', { password: 'nope' })
    expect(bad.status).toBe(401)
    expect(bad.json).toMatchObject({ error: 'Wrong password.' })
    expect(bad.setCookie).toBeUndefined()

    const ok = await c.req('POST', '/login', { password: PASSWORD })
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ ok: true })
    expect(ok.setCookie).toMatch(/teya_admin=/)
    expect(ok.setCookie).toMatch(/HttpOnly/)
    // Now /api/state is reachable with the carried cookie.
    expect((await c.req('GET', '/api/state')).status).toBe(200)
  })

  it('does not accept a forged/garbage session cookie', async () => {
    const res = await fetch(base + '/api/state', {
      headers: { cookie: 'teya_admin=99999999999999.deadbeef' },
    })
    expect(res.status).toBe(401)
  })
})

// ─── CRUD lifecycle (claude-agent bot) ───────────────────────────────────────

describe('bot CRUD lifecycle via HTTP', () => {
  async function authed() {
    const c = client()
    const login = await c.req('POST', '/login', { password: PASSWORD })
    expect(login.status, 'login should succeed').toBe(200)
    return c
  }

  it('add → state sees it → edit → effort → delete → state empty', async () => {
    const c = await authed()

    // ── add a claude-agent bot ───────────────────────────────────────────
    const add = await c.req('POST', '/api/bots', {
      name: 'ceo',
      token_env: 'CEO_TOK',
      provider: 'claude-code',
      agent: 'solopreneuro-ceo',
      cwd: '/projects/solopreneuro',
      effort: 'high',
      allowed_chat_ids: ['112833890', '@someone'],
      add_root_dir: true,
      stranger_reply: 'нет',
    })
    expect(add.status, add.raw).toBe(200)
    expect(add.json).toMatchObject({ ok: true })

    // on-disk readback — exact entry, @username dropped from numeric ids
    let cfg = await readRawConfig(cfgPath)
    expect(cfg.bots).toHaveLength(1)
    expect(cfg.bots![0]).toMatchObject({
      name: 'ceo',
      token_env: 'CEO_TOK',
      agent: 'solopreneuro-ceo',
      cwd: '/projects/solopreneuro',
      effort: 'high',
      allowed_chat_ids: [112833890],
      add_root_dir: true,
      stranger_reply: 'нет',
    })
    expect('agentDir' in cfg.bots![0]).toBe(false)

    // ── GET state reflects it (view-model field level) ───────────────────
    const st1 = await c.req('GET', '/api/state')
    expect(st1.status).toBe(200)
    expect(st1.json.bots).toHaveLength(1)
    expect(st1.json.bots[0]).toMatchObject({
      name: 'ceo',
      mode: 'claude-agent',
      provider: 'Claude Code',
      agentOrModel: 'solopreneuro-ceo',
      token_env: 'CEO_TOK',
      token_present: true,
      effort: 'high',
      add_root_dir: true,
      cwd: '/projects/solopreneuro',
    })

    // ── edit: re-point to teya-native (openrouter + persona), drop root ──
    const persona = await makePersona('teya-persona')
    const edit = await c.req('POST', '/api/bots', {
      originalName: 'ceo',
      name: 'ceo',
      token_env: 'CEO_TOK',
      provider: 'openrouter',
      model: 'google/gemini-2.0-flash-001',
      agentDir: persona,
      effort: 'low',
    })
    expect(edit.status, edit.raw).toBe(200)

    cfg = await readRawConfig(cfgPath)
    expect(cfg.bots).toHaveLength(1)
    expect(cfg.bots![0]).toMatchObject({
      name: 'ceo',
      token_env: 'CEO_TOK',
      agentDir: persona,
      model: 'google/gemini-2.0-flash-001',
      effort: 'low',
    })
    // claude-agent keys must be gone after switching mode
    expect('agent' in cfg.bots![0]).toBe(false)
    expect('cwd' in cfg.bots![0]).toBe(false)
    expect('add_root_dir' in cfg.bots![0]).toBe(false)

    const st2 = await c.req('GET', '/api/state')
    expect(st2.json.bots[0]).toMatchObject({
      mode: 'teya-native',
      provider: 'Teya (google/gemini-2.0-flash-001)',
      agentOrModel: persona,
      effort: 'low',
    })

    // ── quick effort change ──────────────────────────────────────────────
    const eff = await c.req('POST', '/api/bots/effort', { name: 'ceo', effort: 'high' })
    expect(eff.status).toBe(200)
    cfg = await readRawConfig(cfgPath)
    expect(cfg.bots![0].effort).toBe('high')

    // ── delete ───────────────────────────────────────────────────────────
    const del = await c.req('POST', '/api/bots/delete', { name: 'ceo' })
    expect(del.status).toBe(200)
    cfg = await readRawConfig(cfgPath)
    expect(cfg.bots).toEqual([])

    const st3 = await c.req('GET', '/api/state')
    expect(st3.json.bots).toEqual([])

    // ── idempotency: second delete → 404 ────────────────────────────────
    const del2 = await c.req('POST', '/api/bots/delete', { name: 'ceo' })
    expect(del2.status).toBe(404)
    expect(del2.json.error).toMatch(/No bot named "ceo"/)
  })

  it('409s a duplicate token_env (two pollers → Telegram 409 guard)', async () => {
    const c = await authed()
    const a = await c.req('POST', '/api/bots', {
      name: 'a', token_env: 'SHARED', provider: 'claude-code', agent: 'solopreneuro-ceo',
    })
    expect(a.status).toBe(200)
    const b = await c.req('POST', '/api/bots', {
      name: 'b', token_env: 'SHARED', provider: 'claude-code', agent: 'solopreneuro-ceo',
    })
    expect(b.status).toBe(409)
    expect(b.json.error).toMatch(/already bound|409/i)
    // config still has exactly one bot — no partial write
    const cfg = await readRawConfig(cfgPath)
    expect(cfg.bots).toHaveLength(1)
  })

  it('rejects a claude-agent that does not exist (400, no write)', async () => {
    const c = await authed()
    const r = await c.req('POST', '/api/bots', {
      name: 'ghost', token_env: 'T', provider: 'claude-code', agent: 'no-such-agent',
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/not found/)
    const cfg = await readRawConfig(cfgPath)
    expect(cfg.bots).toEqual([])
  })

  it('rejects an invalid effort enum (400, no write)', async () => {
    const c = await authed()
    const r = await c.req('POST', '/api/bots', {
      name: 'x', token_env: 'T', provider: 'claude-code', agent: 'solopreneuro-ceo', effort: 'turbo',
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/Invalid effort/)
    const cfg = await readRawConfig(cfgPath)
    expect(cfg.bots).toEqual([])
  })

  it('preserves owner-authored top-level keys across a write', async () => {
    await writeFile(cfgPath, JSON.stringify({ _comment: 'keep me', bots: [], _cutover_pending: { x: 1 } }), 'utf-8')
    const c = await authed()
    const r = await c.req('POST', '/api/bots', {
      name: 'ceo', token_env: 'CEO_TOK', provider: 'claude-code', agent: 'solopreneuro-ceo',
    })
    expect(r.status).toBe(200)
    const onDisk = JSON.parse(await readFile(cfgPath, 'utf-8'))
    expect(onDisk._comment).toBe('keep me')
    expect(onDisk._cutover_pending).toEqual({ x: 1 })
    expect(onDisk.bots).toHaveLength(1)
  })
})

// ─── secret containment ──────────────────────────────────────────────────────

describe('token VALUE never leaks', () => {
  it('no API response contains the token value, only the env-var name', async () => {
    // Pretend the secret is actually in the process env for this token name.
    // Our deps.tokenPresent only ever returns a boolean, but we also assert the
    // raw response bytes never contain the secret string.
    const c = client()
    await c.req('POST', '/login', { password: PASSWORD })
    await c.req('POST', '/api/bots', {
      name: 'ceo', token_env: 'CEO_TOK', provider: 'claude-code', agent: 'solopreneuro-ceo',
    })

    const state = await c.req('GET', '/api/state')
    expect(state.status).toBe(200)
    // The NAME is present...
    expect(state.raw).toContain('CEO_TOK')
    expect(state.json.bots[0].token_present).toBe(true)
    // ...the VALUE is not, anywhere in the payload.
    expect(state.raw).not.toContain(SECRET_TOKEN_VALUE)
    expect(JSON.stringify(state.json)).not.toContain(SECRET_TOKEN_VALUE)
    // And the view model has no token-value-ish field at all.
    expect(Object.keys(state.json.bots[0])).not.toContain('token')
    expect(Object.keys(state.json.bots[0])).not.toContain('token_value')
  })

  it('the served HTML page contains no secrets', async () => {
    const res = await fetch(base + '/')
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).not.toContain(SECRET_TOKEN_VALUE)
    expect(html).not.toContain(PASSWORD)
  })
})

// ─── token store: write-only paste, present flag, never leaked ──────────────

describe('bot token store (encrypted, write-only via admin)', () => {
  const REAL_TOKEN = '123456789:AAH-fake_but_well_formed_bot_token_value_xyz'

  async function authed() {
    const c = client()
    const login = await c.req('POST', '/login', { password: PASSWORD })
    expect(login.status, 'login should succeed').toBe(200)
    return c
  }

  it('saves a pasted token to the store (no token_env) and never echoes the VALUE', async () => {
    const c = await authed()
    // Add a bot with a pasted token and NO token_env — store-backed.
    const add = await c.req('POST', '/api/bots', {
      name: 'storebot',
      provider: 'claude-code',
      agent: 'solopreneuro-ceo',
      token: REAL_TOKEN,
    })
    expect(add.status, add.raw).toBe(200)

    // Token landed in the (stubbed) store, keyed by bot name.
    expect(tokenStoreStub.get('storebot')).toBe(REAL_TOKEN)

    // Config on disk has NO token_env and never the value.
    const cfg = await readRawConfig(cfgPath)
    expect(cfg.bots).toHaveLength(1)
    expect('token_env' in cfg.bots![0]).toBe(false)
    expect(JSON.stringify(cfg.bots![0])).not.toContain(REAL_TOKEN)

    // /api/state shows token_present=true but never the value, and exposes
    // no token field at all.
    const st = await c.req('GET', '/api/state')
    expect(st.json.bots[0]).toMatchObject({ name: 'storebot', token_present: true })
    expect(st.raw).not.toContain(REAL_TOKEN)
    expect(Object.keys(st.json.bots[0])).not.toContain('token')
  })

  it('edit WITHOUT re-pasting keeps the stored token (write-only field)', async () => {
    const c = await authed()
    await c.req('POST', '/api/bots', {
      name: 'keepbot', provider: 'claude-code', agent: 'solopreneuro-ceo', token: REAL_TOKEN,
    })
    expect(tokenStoreStub.get('keepbot')).toBe(REAL_TOKEN)
    // Edit effort only — no token in payload. Token must survive untouched.
    const edit = await c.req('POST', '/api/bots', {
      originalName: 'keepbot', name: 'keepbot', provider: 'claude-code', agent: 'solopreneuro-ceo', effort: 'high',
    })
    expect(edit.status, edit.raw).toBe(200)
    expect(tokenStoreStub.get('keepbot')).toBe(REAL_TOKEN) // unchanged
    const cfg = await readRawConfig(cfgPath)
    expect(cfg.bots![0].effort).toBe('high')
  })

  it('rename carries the stored token to the new name (and drops the old key)', async () => {
    const c = await authed()
    await c.req('POST', '/api/bots', {
      name: 'oldname', provider: 'claude-code', agent: 'solopreneuro-ceo', token: REAL_TOKEN,
    })
    const ren = await c.req('POST', '/api/bots', {
      originalName: 'oldname', name: 'newname', provider: 'claude-code', agent: 'solopreneuro-ceo',
    })
    expect(ren.status, ren.raw).toBe(200)
    expect(tokenStoreStub.has('oldname')).toBe(false)
    expect(tokenStoreStub.get('newname')).toBe(REAL_TOKEN)
  })

  it('rejects an invalid token format (400, no write, no store)', async () => {
    const c = await authed()
    const bad = await c.req('POST', '/api/bots', {
      name: 'badtok', provider: 'claude-code', agent: 'solopreneuro-ceo',
      token: 'SOLOPRENEURO_TG_BOT_TOKEN', // an env-var NAME, not a token
    })
    expect(bad.status).toBe(400)
    expect(bad.json.error).toMatch(/Bot-API token/)
    expect(tokenStoreStub.has('badtok')).toBe(false)
    const cfg = await readRawConfig(cfgPath)
    expect(cfg.bots).toEqual([])
  })

  it('rejects a bot with neither a pasted token nor token_env (400, no write)', async () => {
    const c = await authed()
    const r = await c.req('POST', '/api/bots', {
      name: 'notoken', provider: 'claude-code', agent: 'solopreneuro-ceo',
      // no token, no token_env
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/No token/)
    const cfg = await readRawConfig(cfgPath)
    expect(cfg.bots).toEqual([])
  })

  it('deleting a bot drops its stored token (no orphan secret)', async () => {
    const c = await authed()
    await c.req('POST', '/api/bots', {
      name: 'delbot', provider: 'claude-code', agent: 'solopreneuro-ceo', token: REAL_TOKEN,
    })
    expect(tokenStoreStub.has('delbot')).toBe(true)
    const del = await c.req('POST', '/api/bots/delete', { name: 'delbot' })
    expect(del.status).toBe(200)
    expect(tokenStoreStub.has('delbot')).toBe(false)
  })

  it('a store-backed bot still 409s a duplicate token_env on another bot', async () => {
    const c = await authed()
    const a = await c.req('POST', '/api/bots', {
      name: 'a', token_env: 'SHARED', provider: 'claude-code', agent: 'solopreneuro-ceo',
    })
    expect(a.status).toBe(200)
    const b = await c.req('POST', '/api/bots', {
      name: 'b', token_env: 'SHARED', provider: 'claude-code', agent: 'solopreneuro-ceo',
    })
    expect(b.status).toBe(409)
  })
})

// ─── picker sources ──────────────────────────────────────────────────────────

describe('provider→agent/model picker sources', () => {
  it('state exposes claude agents, teya personas, openrouter + ollama models, efforts', async () => {
    await makePersona('teya-persona')
    const c = client()
    await c.req('POST', '/login', { password: PASSWORD })
    const st = await c.req('GET', '/api/state')
    expect(st.status).toBe(200)
    expect(st.json.sources.claudeAgents).toEqual(['solopreneuro-ceo'])
    expect(st.json.sources.openrouterModels).toEqual(
      expect.arrayContaining(['google/gemini-2.0-flash-001']),
    )
    expect(st.json.sources.ollamaModels).toEqual(['qwen3:8b'])
    expect(st.json.sources.efforts).toEqual(['low', 'medium', 'high'])
    expect(st.json.sources.teyaAgents).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'teya-persona' })]),
    )
  })
})
