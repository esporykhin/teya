/**
 * @description Local web admin for the Telegram multiplexer — a visual control
 *   panel over ~/.teya/telegram.json. Renders a single page that lists every
 *   bot (provider/mode, agent-or-model, token presence, access, effort, cwd,
 *   service-loaded) and lets the owner add / edit / remove bindings. All
 *   mutations go through the SAME core (`telegram-multi-config.ts`) the CLI uses
 *   — atomic read-modify-write that preserves owner keys (`_comment` etc).
 *
 *   SECURITY MODEL (this UI decides who can run `claude` on this machine):
 *     - Binds ONLY to 127.0.0.1 — never 0.0.0.0.
 *     - Every route except /login is gated behind a signed session cookie.
 *       The signing key + admin password come from TEYA_ADMIN_PASSWORD (a
 *       random one is generated and printed if unset).
 *     - Token VALUES are never read or returned — only the env-var NAME and a
 *       boolean "is it populated" (checked the same way the CLI checks it).
 *     - Server-side validation reuses the core's 409 dup-token guard, effort
 *       enum, and agent-exists check; the browser is never trusted.
 *
 * @exports runAdminServer, createAdminServer, AdminServerHandle, AdminDeps
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import { randomBytes, createHmac, timingSafeEqual } from 'crypto'
import { readFile } from 'fs/promises'
import { readFileSync, statSync } from 'fs'
import { spawnSync } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import {
  TELEGRAM_MULTI_CONFIG_FILE,
  readRawConfig,
  writeRawConfig,
  addBotEntry,
  setBotAgent,
  setBotEffort,
  removeBotEntry,
  listClaudeAgents,
  listAgents,
  claudeAgentExists,
  resolveAgentDir,
  expandHome,
  isBotEffort,
  isValidBotToken,
  DEFAULT_EFFORT,
  type RawTelegramConfig,
  type TelegramMultiBotEntry,
  type BotEffort,
} from './telegram-multi-config.js'
import { TokenStore } from '@teya/data'

const LAUNCHD_LABEL = 'com.teya.telegram'
const SESSION_COOKIE = 'teya_admin'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12h

/**
 * Injectable side-effects so tests can drive the HTTP API against a temp config
 * without touching the live file, without shelling out to launchctl, and
 * without depending on real ~/.claude/agents. Production wires the real ones.
 */
export interface AdminDeps {
  /** Path to telegram.json (default: the live ~/.teya/telegram.json). */
  configPath: string
  /** Admin password — gates login; also the HMAC key for the session cookie. */
  password: string
  /** Is the launchd multiplexer loaded? (default: real launchctl probe.) */
  serviceLoaded: () => boolean
  /** Hot-reload the multiplexer. (default: real launchctl kickstart.) */
  reload: () => { ok: boolean; message: string }
  /**
   * Best-effort: does this bot have a usable token? Checks the encrypted
   * token-store (by bot name) first, then the legacy env var. Returns ONLY a
   * boolean — the token value NEVER leaves this function.
   */
  tokenPresent: (botName: string, tokenEnv?: string) => boolean
  /** Store an encrypted token for a bot (write-only; value never read back out). */
  setToken: (botName: string, token: string) => void
  /** Drop a bot's stored token (called on bot delete). */
  deleteToken: (botName: string) => void
  /** True iff the bot has a token in the STORE (ignores env) — used to decide
   *  whether an edit without a re-pasted token still has a usable token. */
  tokenPresentInStore: (botName: string) => boolean
  /** Re-key a stored token (rename) without decrypting it. */
  renameToken: (oldName: string, newName: string) => void
  /** Claude Code agents for the picker. */
  listClaudeAgents: typeof listClaudeAgents
  /** Teya personas for the native picker. */
  listTeyaAgents: typeof listAgents
  /** OpenRouter model ids for the picker. */
  listOpenRouterModels: () => string[]
  /** Ollama model names for the picker. */
  listOllamaModels: () => string[]
  /** Validate a claude agent exists (server-side guard). */
  claudeAgentExists: typeof claudeAgentExists
  /** Resolve + validate a teya persona dir (server-side guard). */
  resolveAgentDir: typeof resolveAgentDir
}

// ─── default (production) side-effects ───────────────────────────────────────

/** Real launchctl probe — is the multiplexer service loaded? */
export function launchdServiceLoaded(): boolean {
  const r = spawnSync('launchctl', ['list', LAUNCHD_LABEL], { encoding: 'utf-8' })
  return r.status === 0
}

/** Real hot-reload via launchctl kickstart. Never throws. */
export function hotReload(): { ok: boolean; message: string } {
  if (!launchdServiceLoaded()) {
    return { ok: false, message: `Service ${LAUNCHD_LABEL} not loaded — start the multiplexer, then it'll pick up the new config.` }
  }
  const uid = String(process.getuid?.() ?? '')
  const r = spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${LAUNCHD_LABEL}`], { encoding: 'utf-8' })
  if (r.status === 0) return { ok: true, message: `Reloaded ${LAUNCHD_LABEL} — new binding is live.` }
  return { ok: false, message: `Reload failed (${r.stderr?.trim() || `exit ${r.status}`}).` }
}

/**
 * Is a token available for this bot? Checks the encrypted token-store (by bot
 * name) FIRST — the new preferred source — then the legacy env var in
 * process.env / ~/.claude/credentials.env (the file the launchd wrapper
 * sources). Returns ONLY a boolean — the value never leaves this function.
 * Mirrors resolveBots' store>env precedence.
 */
export function tokenPresentDefault(store: TokenStore, botName: string, tokenEnv?: string): boolean {
  if (store.hasToken(botName)) return true
  if (!tokenEnv) return false
  if (process.env[tokenEnv]) return true
  const credsPath = join(homedir(), '.claude', 'credentials.env')
  try {
    const text = readFileSync(credsPath, 'utf-8')
    const re = new RegExp(`^\\s*${tokenEnv}\\s*=\\s*(.+?)\\s*$`, 'm')
    const m = text.match(re)
    return !!(m && m[1].replace(/^["']|["']$/g, ''))
  } catch {
    return false
  }
}

/** OpenRouter model ids from the on-disk cache (~/.teya/openrouter-models.json). */
export function listOpenRouterModelsDefault(): string[] {
  const file = join(homedir(), '.teya', 'openrouter-models.json')
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ id?: string }>
    return data.map((m) => m.id).filter((x): x is string => typeof x === 'string').sort()
  } catch {
    return []
  }
}

/** Locally-installed Ollama model names via `ollama list` (graceful if absent). */
export function listOllamaModelsDefault(): string[] {
  const r = spawnSync('ollama', ['list'], { encoding: 'utf-8' })
  if (r.status !== 0 || !r.stdout) return []
  // `ollama list` prints a header row then `NAME  ID  SIZE  MODIFIED` columns.
  return r.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name && name !== 'NAME')
}

/** Build the production deps from a config path + password. Opens the shared
 *  encrypted TokenStore (~/.teya/secrets.db) used for present-checks + writes. */
export function defaultDeps(configPath: string, password: string): AdminDeps {
  const store = new TokenStore()
  return {
    configPath,
    password,
    serviceLoaded: launchdServiceLoaded,
    reload: hotReload,
    tokenPresent: (botName, tokenEnv) => tokenPresentDefault(store, botName, tokenEnv),
    setToken: (botName, token) => store.setToken(botName, token),
    deleteToken: (botName) => { store.deleteToken(botName) },
    tokenPresentInStore: (botName) => store.hasToken(botName),
    renameToken: (oldName, newName) => store.renameToken(oldName, newName),
    listClaudeAgents,
    listTeyaAgents: listAgents,
    listOpenRouterModels: listOpenRouterModelsDefault,
    listOllamaModels: listOllamaModelsDefault,
    claudeAgentExists,
    resolveAgentDir,
  }
}

// ─── session cookie (signed, HMAC-SHA256) ────────────────────────────────────

/**
 * Mint a signed session token: `<expiryMs>.<hmac>`. The HMAC is keyed on the
 * admin password, so a token can't be forged without it and rotating the
 * password invalidates every outstanding session.
 */
function mintSession(password: string): string {
  const exp = Date.now() + SESSION_TTL_MS
  const sig = createHmac('sha256', password).update(String(exp)).digest('hex')
  return `${exp}.${sig}`
}

/** Verify a session token: signature valid AND not expired. Constant-time. */
function verifySession(token: string | undefined, password: string): boolean {
  if (!token) return false
  const dot = token.indexOf('.')
  if (dot < 0) return false
  const exp = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false
  const expected = createHmac('sha256', password).update(exp).digest('hex')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Constant-time password compare (avoids leaking length via early-return). */
function passwordMatches(input: string, password: string): boolean {
  const a = Buffer.from(input)
  const b = Buffer.from(password)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

// ─── request helpers ─────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) {
        reject(new Error('Request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

// ─── view model: bots → safe summary (never leaks token values) ──────────────

interface BotView {
  name: string
  mode: 'claude-agent' | 'teya-native'
  provider: string
  agentOrModel: string
  token_env: string
  token_present: boolean
  allowed_chat_ids: Array<number | string>
  effort: BotEffort
  cwd?: string
  add_root_dir: boolean
  stranger_reply?: string
  model?: string
  agent?: string
  agentDir?: string
}

/**
 * Build the UI view for one bot. Resolves mode + a human "provider" label.
 * claude-agent → Claude Code (the only mode that drives `claude --agent`).
 * teya-native → the teya provider depends on the bot's model/global default;
 * we surface the model so the owner sees what runs. Token VALUE never read.
 */
function botToView(b: TelegramMultiBotEntry, tokenPresent: (botName: string, tokenEnv?: string) => boolean): BotView {
  const mode: BotView['mode'] = b.agent ? 'claude-agent' : 'teya-native'
  const provider = b.agent ? 'Claude Code' : b.model ? `Teya (${b.model})` : 'Teya (default model)'
  const agentOrModel = b.agent || b.agentDir || b.model || '(teya default)'
  return {
    name: b.name,
    mode,
    provider,
    agentOrModel,
    token_env: b.token_env ?? '',
    token_present: tokenPresent(b.name, b.token_env),
    allowed_chat_ids: b.allowed_chat_ids ?? [],
    effort: b.effort ?? DEFAULT_EFFORT,
    cwd: b.cwd,
    add_root_dir: b.add_root_dir === true,
    stranger_reply: b.stranger_reply,
    model: b.model,
    agent: b.agent,
    agentDir: b.agentDir,
  }
}

// ─── add/edit payload ────────────────────────────────────────────────────────

type Provider = 'claude-code' | 'codex' | 'openrouter' | 'ollama'

interface BotPayload {
  name?: unknown
  token_env?: unknown
  /**
   * WRITE-ONLY real Bot-API token pasted by the owner. Stored encrypted in the
   * token-store keyed by bot name; NEVER read back / returned. Empty/absent ⇒
   * leave any existing stored token untouched.
   */
  token?: unknown
  provider?: unknown
  /** claude-code/codex: the agent name. */
  agent?: unknown
  /** openrouter/ollama: the model id. */
  model?: unknown
  /** teya-native: persona dir (optional alongside model). */
  agentDir?: unknown
  effort?: unknown
  allowed_chat_ids?: unknown
  cwd?: unknown
  add_root_dir?: unknown
  stranger_reply?: unknown
}

/** Numeric-only chat-id coercion. @username strings claim-on-contact, so we
 *  keep non-numeric ids verbatim (the daemon resolves them on first message). */
function coerceAllowed(raw: unknown): Array<number | string> {
  if (!Array.isArray(raw)) return []
  const out: Array<number | string> = []
  for (const v of raw) {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v)
    else if (typeof v === 'string') {
      const t = v.trim()
      if (!t) continue
      const n = Number(t)
      out.push(Number.isFinite(n) && !t.startsWith('@') ? n : t)
    }
  }
  return out
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

/**
 * Apply an add-or-edit. On edit (bot exists) we remove the old entry first
 * then re-add — simplest path that reuses addBotEntry's full validation
 * (dup-name/token guards, mode exclusivity) while letting the owner change
 * provider/mode freely. The dup-token guard is re-checked AGAINST the post-
 * removal config so editing a bot without changing its token doesn't 409 on
 * itself. Mutates `cfg`; caller persists.
 */
async function applyBot(cfg: RawTelegramConfig, p: BotPayload, deps: AdminDeps, originalName?: string): Promise<void> {
  const name = str(p.name)
  const tokenEnv = str(p.token_env)
  const token = str(p.token) // WRITE-ONLY pasted token (value, not a name)
  const provider = str(p.provider) as Provider | undefined
  if (!name) throw new Error('Bot name is required.')
  if (!provider) throw new Error('Provider is required.')

  // Validate a pasted token's SHAPE before we store it (rejects an env-var NAME
  // pasted into the value field, empty junk, etc). An empty token is allowed —
  // it means "don't change the existing stored token".
  if (token !== undefined && !isValidBotToken(token)) {
    throw new Error('That does not look like a Bot-API token (expected "<id>:<secret>"). Paste the real token from @BotFather, or leave it blank to keep the current one.')
  }

  // A bot needs SOME token source: either a freshly pasted token (→ store), an
  // already-stored token (edit without re-pasting), or a legacy token_env.
  const willHaveStoredToken = !!token || deps.tokenPresentInStore(originalName || name)
  if (!willHaveStoredToken && !tokenEnv) {
    throw new Error('No token: paste a Bot token, or set token_env (legacy env-var fallback).')
  }

  const effortRaw = str(p.effort)
  if (effortRaw !== undefined && !isBotEffort(effortRaw)) {
    throw new Error(`Invalid effort "${effortRaw}" — expected low, medium, or high.`)
  }
  const effort = effortRaw as BotEffort | undefined
  const allowed = coerceAllowed(p.allowed_chat_ids).filter((v): v is number => typeof v === 'number')
  // @username / non-numeric ids are dropped from allowed_chat_ids (the core only
  // stores numeric ids) — the daemon claims them on first contact. We keep them
  // out of the file so resolveBots' Number() coercion doesn't NaN them.
  const model = str(p.model)
  const claudeOrCodexAgent = str(p.agent)
  const personaDir = str(p.agentDir)

  // Build the per-mode add input.
  const input: Parameters<typeof addBotEntry>[1] = {
    name,
    token_env: tokenEnv,
    allowed_chat_ids: allowed.length ? allowed : undefined,
    effort,
  }

  if (provider === 'claude-code' || provider === 'codex') {
    // CLAUDE-AGENT mode. Codex has no native agents dir, so its agent name is
    // free-text and only validated for presence; claude-code agents are checked
    // against ~/.claude/agents/<name>.md.
    if (!claudeOrCodexAgent) throw new Error('An agent name is required for Claude Code / Codex.')
    if (provider === 'claude-code' && !(await deps.claudeAgentExists(claudeOrCodexAgent))) {
      throw new Error(`Claude Code agent "${claudeOrCodexAgent}" not found (~/.claude/agents/${claudeOrCodexAgent}.md).`)
    }
    const cwd = str(p.cwd)
    input.claudeAgent = {
      agent: claudeOrCodexAgent,
      cwd: cwd ? expandHome(cwd) : undefined,
      stranger_reply: str(p.stranger_reply),
    }
  } else {
    // TEYA-NATIVE mode (openrouter / ollama). addBotEntry requires a persona
    // dir (SOUL.md/AGENTS.md) — the model only picks which teya provider/model
    // runs that persona. A model with no persona has nothing to execute.
    if (!personaDir) {
      throw new Error('A Teya-native bot needs a persona dir (SOUL.md/AGENTS.md). Select one, or use Claude Code mode.')
    }
    input.agentDir = await deps.resolveAgentDir({ agentDir: expandHome(personaDir) })
    if (model) input.model = model
  }

  // On edit: drop the existing entry so addBotEntry's dup guards see a clean
  // slate. originalName lets a rename work (remove old name, add new).
  const existingName = originalName || name
  const bots = cfg.bots ?? (cfg.bots = [])
  const idx = bots.findIndex((b) => b.name === existingName)
  if (idx !== -1) bots.splice(idx, 1)

  addBotEntry(cfg, input)

  // add_root_dir is not a parameter of addBotEntry — set it directly on the
  // freshly-added entry (claude-agent mode only; ignored for teya-native).
  if (provider === 'claude-code' || provider === 'codex') {
    const added = (cfg.bots ?? []).find((b) => b.name === name)
    if (added && (p.add_root_dir === true || p.add_root_dir === 'true')) added.add_root_dir = true
  }

  // ── token-store side-effects (after the config entry validated/added) ──
  // On rename, carry an already-stored token to the new key so the bot keeps
  // its secret. renameToken moves the ciphertext row in-store WITHOUT ever
  // surfacing the plaintext (the value never leaves the store).
  if (originalName && originalName !== name && deps.tokenPresentInStore(originalName)) {
    deps.renameToken(originalName, name)
  }
  // A freshly pasted token overrides whatever was there (rotation). Stored
  // encrypted under the bot NAME; the value never round-trips back out.
  if (token) deps.setToken(name, token)
}

// ─── HTTP handler ────────────────────────────────────────────────────────────

/**
 * The request router. Pure-ish: all I/O goes through `deps`, so tests drive it
 * with a temp config + stub side-effects. Returns nothing; writes to `res`.
 */
async function handle(req: IncomingMessage, res: ServerResponse, deps: AdminDeps): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname
  const cookies = parseCookies(req.headers.cookie)
  const authed = verifySession(cookies[SESSION_COOKIE], deps.password)

  // ── login (the only un-gated route besides static login page) ──────────────
  if (path === '/login' && req.method === 'POST') {
    let body: { password?: string }
    try {
      body = JSON.parse(await readBody(req)) as { password?: string }
    } catch {
      return sendJson(res, 400, { error: 'Bad request body.' })
    }
    if (!body.password || !passwordMatches(body.password, deps.password)) {
      return sendJson(res, 401, { error: 'Wrong password.' })
    }
    const token = mintSession(deps.password)
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
    })
    return res.end(JSON.stringify({ ok: true }))
  }

  if (path === '/logout' && req.method === 'POST') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    })
    return res.end(JSON.stringify({ ok: true }))
  }

  // ── the page itself (shows login form or app shell; data fetched via API) ──
  if (path === '/' && req.method === 'GET') {
    return sendHtml(res, 200, PAGE_HTML)
  }

  // ── everything else is API and requires a valid session ────────────────────
  if (path.startsWith('/api/')) {
    if (!authed) return sendJson(res, 401, { error: 'Not authenticated.' })

    // GET /api/state — bots + service status + picker sources.
    if (path === '/api/state' && req.method === 'GET') {
      const cfg = await readRawConfig(deps.configPath)
      const bots = (cfg.bots ?? []).map((b) => botToView(b, deps.tokenPresent))
      const claudeAgents = (await deps.listClaudeAgents()).map((a) => a.name)
      const teyaAgents = (await deps.listTeyaAgents()).map((a) => ({ name: a.name, path: a.path }))
      return sendJson(res, 200, {
        bots,
        service_loaded: deps.serviceLoaded(),
        sources: {
          claudeAgents,
          teyaAgents,
          openrouterModels: deps.listOpenRouterModels(),
          ollamaModels: deps.listOllamaModels(),
          efforts: ['low', 'medium', 'high'],
        },
      })
    }

    // POST /api/bots — add or edit (idempotent on name; originalName renames).
    if (path === '/api/bots' && req.method === 'POST') {
      let payload: BotPayload & { originalName?: string }
      try {
        payload = JSON.parse(await readBody(req)) as BotPayload & { originalName?: string }
      } catch {
        return sendJson(res, 400, { error: 'Bad request body.' })
      }
      const cfg = await readRawConfig(deps.configPath)
      try {
        await applyBot(cfg, payload, deps, str(payload.originalName))
      } catch (err) {
        // addBotEntry throws a dup-token/name 409-class error — surface as 409.
        const msg = (err as Error).message
        const status = /already bound|already exists|409/i.test(msg) ? 409 : 400
        return sendJson(res, status, { error: msg })
      }
      await writeRawConfig(cfg, deps.configPath)
      return sendJson(res, 200, { ok: true })
    }

    // POST /api/bots/effort — quick effort change without a full edit.
    if (path === '/api/bots/effort' && req.method === 'POST') {
      let body: { name?: string; effort?: string }
      try {
        body = JSON.parse(await readBody(req)) as { name?: string; effort?: string }
      } catch {
        return sendJson(res, 400, { error: 'Bad request body.' })
      }
      if (!body.name) return sendJson(res, 400, { error: 'name is required.' })
      if (!body.effort || !isBotEffort(body.effort)) {
        return sendJson(res, 400, { error: 'effort must be low, medium, or high.' })
      }
      const cfg = await readRawConfig(deps.configPath)
      try {
        setBotEffort(cfg, body.name, body.effort)
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message })
      }
      await writeRawConfig(cfg, deps.configPath)
      return sendJson(res, 200, { ok: true })
    }

    // POST /api/bots/delete — remove a binding.
    if (path === '/api/bots/delete' && req.method === 'POST') {
      let body: { name?: string }
      try {
        body = JSON.parse(await readBody(req)) as { name?: string }
      } catch {
        return sendJson(res, 400, { error: 'Bad request body.' })
      }
      if (!body.name) return sendJson(res, 400, { error: 'name is required.' })
      const cfg = await readRawConfig(deps.configPath)
      try {
        removeBotEntry(cfg, body.name)
      } catch (err) {
        return sendJson(res, 404, { error: (err as Error).message })
      }
      await writeRawConfig(cfg, deps.configPath)
      // Drop the bot's encrypted token too — no orphan secrets after delete.
      deps.deleteToken(body.name)
      return sendJson(res, 200, { ok: true })
    }

    // POST /api/reload — kickstart the launchd service.
    if (path === '/api/reload' && req.method === 'POST') {
      const r = deps.reload()
      return sendJson(res, r.ok ? 200 : 502, r)
    }

    return sendJson(res, 404, { error: 'Unknown API route.' })
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('Not found')
}

// ─── public surface ──────────────────────────────────────────────────────────

export interface AdminServerHandle {
  server: Server
  /** The 127.0.0.1 URL the server is listening on (once started). */
  url: () => string
  close: () => Promise<void>
}

/** Build (but don't start) the admin HTTP server with the given deps. */
export function createAdminServer(deps: AdminDeps): Server {
  return createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      try {
        sendJson(res, 500, { error: (err as Error).message || 'Internal error' })
      } catch {
        /* response already sent */
      }
    })
  })
}

/**
 * Start the admin server. Binds to 127.0.0.1 ONLY (loopback) — this UI grants
 * the ability to run `claude` with disk access, so it must never be reachable
 * off-host. If TEYA_ADMIN_PASSWORD is unset a random one is generated and
 * printed to the console (along with the URL) so the owner can log in.
 */
export async function runAdminServer(opts: { port?: number; configPath?: string } = {}): Promise<AdminServerHandle> {
  const port = opts.port ?? Number(process.env.TEYA_ADMIN_PORT) ?? 4848
  const configPath = opts.configPath ?? TELEGRAM_MULTI_CONFIG_FILE

  let password = process.env.TEYA_ADMIN_PASSWORD || ''
  let generated = false
  if (!password) {
    password = randomBytes(18).toString('base64url')
    generated = true
  }

  const deps = defaultDeps(configPath, password)
  const server = createAdminServer(deps)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Bind ONLY to loopback — never 0.0.0.0.
    server.listen(port, '127.0.0.1', resolve)
  })

  const addr = server.address()
  const boundPort = typeof addr === 'object' && addr ? addr.port : port
  const urlStr = `http://127.0.0.1:${boundPort}/`

  console.log(`\n\x1b[1mTeya Admin\x1b[0m — local bot control panel`)
  console.log(`  URL:    \x1b[36m${urlStr}\x1b[0m`)
  console.log(`  Config: ${configPath}`)
  if (generated) {
    console.log(`  Password (generated): \x1b[33m${password}\x1b[0m`)
    console.log(`  (set TEYA_ADMIN_PASSWORD to pin your own.)`)
  } else {
    console.log(`  Password: from TEYA_ADMIN_PASSWORD`)
  }
  console.log(`\nBound to 127.0.0.1 only. Ctrl-C to stop.\n`)

  return {
    server,
    url: () => urlStr,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// ─── inline single-page UI ───────────────────────────────────────────────────
// One self-contained HTML page (no build step, no external assets). It fetches
// /api/state, renders the bot table + an add/edit form whose agent-vs-model
// picker switches on the chosen provider, and POSTs back to the API.

const PAGE_HTML = /* html */ `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Teya Admin</title>
<style>
  :root { --bg:#0f1115; --panel:#181b22; --line:#2a2f3a; --fg:#e6e8ec; --muted:#8b93a1; --accent:#5b8cff; --ok:#3ecf8e; --bad:#ff6b6b; --warn:#ffce5b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { padding:16px 24px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:16px; }
  header h1 { font-size:18px; margin:0; }
  header .status { color:var(--muted); font-size:13px; }
  main { padding:24px; max-width:1100px; margin:0 auto; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:8px 14px; cursor:pointer; font-size:13px; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--fg); }
  button.danger { background:transparent; border:1px solid var(--bad); color:var(--bad); }
  button:disabled { opacity:.5; cursor:default; }
  table { width:100%; border-collapse:collapse; margin-top:8px; }
  th,td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .tag { display:inline-block; padding:1px 7px; border-radius:4px; font-size:12px; background:#222734; color:var(--muted); }
  .ok { color:var(--ok); } .bad { color:var(--bad); } .warn { color:var(--warn); }
  .muted { color:var(--muted); }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; margin-top:20px; }
  label { display:block; font-size:12px; color:var(--muted); margin:10px 0 4px; }
  input,select,textarea { width:100%; background:#0f1218; border:1px solid var(--line); color:var(--fg); border-radius:6px; padding:8px; font:inherit; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .hidden { display:none; }
  .actions { display:flex; gap:8px; margin-top:16px; }
  .toast { position:fixed; right:20px; bottom:20px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px 16px; max-width:380px; }
  .toast.err { border-color:var(--bad); }
  #login { max-width:340px; margin:80px auto; }
  .switch { display:flex; align-items:center; gap:8px; }
  .switch input { width:auto; }
</style>
</head>
<body>
<div id="login" class="panel hidden">
  <h2 style="margin-top:0">Teya Admin</h2>
  <label>Password</label>
  <input id="pw" type="password" autofocus />
  <div class="actions"><button onclick="doLogin()">Войти</button></div>
  <div id="loginErr" class="bad" style="margin-top:8px"></div>
</div>

<div id="app" class="hidden">
  <header>
    <h1>Teya Admin</h1>
    <span class="status" id="svc"></span>
    <span style="flex:1"></span>
    <button class="ghost" onclick="reload()">Reload service</button>
    <button class="ghost" onclick="logout()">Выйти</button>
  </header>
  <main>
    <div style="display:flex;align-items:center">
      <h2 style="flex:1;font-size:16px">Боты</h2>
      <button onclick="newBot()">+ Добавить бота</button>
    </div>
    <table id="bots"><thead><tr>
      <th>Имя</th><th>Провайдер / режим</th><th>Агент / модель</th><th>Токен</th>
      <th>Доступ</th><th>Effort</th><th>cwd</th><th>root</th><th></th>
    </tr></thead><tbody></tbody></table>

    <div id="form" class="panel hidden">
      <h3 id="formTitle" style="margin-top:0">Новый бот</h3>
      <input type="hidden" id="originalName" />
      <div class="row">
        <div><label>Имя бота</label><input id="f_name" placeholder="ceo" /></div>
        <div><label>Bot token <span class="muted">(от @BotFather — вставь сюда, хранится зашифрованным)</span></label>
          <input id="f_bottoken" type="password" autocomplete="off" placeholder="123456:ABC-DEF... (пусто = не менять)" />
          <div id="tokenState" class="muted" style="font-size:12px;margin-top:4px"></div>
        </div>
      </div>
      <details style="margin-top:6px">
        <summary class="muted" style="cursor:pointer;font-size:12px">Legacy: token_env (имя env-переменной вместо токена)</summary>
        <label>token_env (имя переменной окружения, НЕ значение) — опционально, фоллбэк</label>
        <input id="f_token" placeholder="SOLOPRENEURO_TG_BOT_TOKEN" />
      </details>
      <label>Провайдер</label>
      <select id="f_provider" onchange="onProvider()">
        <option value="claude-code">Claude Code</option>
        <option value="codex">Codex</option>
        <option value="openrouter">Teya (OpenRouter)</option>
        <option value="ollama">Локальная (Ollama)</option>
      </select>

      <div id="agentBlock">
        <label id="agentLabel">Агент</label>
        <select id="f_agentSelect"></select>
        <div id="codexAgentBlock" class="hidden">
          <label>Имя Codex-агента (свободный ввод — у Codex нет нативного списка)</label>
          <input id="f_codexAgent" placeholder="my-codex-agent" />
        </div>
      </div>

      <div id="modelBlock" class="hidden">
        <label>Модель</label>
        <select id="f_model"></select>
        <label>Teya-персона (SOUL.md / AGENTS.md)</label>
        <select id="f_persona"></select>
      </div>

      <div class="row">
        <div><label>Effort</label>
          <select id="f_effort"><option>low</option><option selected>medium</option><option>high</option></select>
        </div>
        <div id="cwdBlock"><label>cwd (рабочая папка для claude)</label><input id="f_cwd" placeholder="~/projects/solopreneuro" /></div>
      </div>

      <label>Доступ — разрешённые user id (по одному в строке; @username сохранится как claim-on-contact, id появится после первого сообщения)</label>
      <textarea id="f_allowed" rows="3" placeholder="112833890&#10;@someuser"></textarea>

      <div class="row">
        <div id="strangerBlock"><label>Ответ незнакомцам (stranger_reply)</label><input id="f_stranger" /></div>
        <div id="rootBlock"><label>add_root_dir (доступ ко всей ФС)</label>
          <div class="switch"><input type="checkbox" id="f_root" /><span class="muted">Включать только для доверенных агентов</span></div>
        </div>
      </div>

      <div class="actions">
        <button onclick="save()">Сохранить</button>
        <button class="ghost" onclick="closeForm()">Отмена</button>
      </div>
    </div>
  </main>
</div>

<script>
let STATE = null;

function el(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function toast(msg, err){ const t=document.createElement('div'); t.className='toast'+(err?' err':''); t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(), 4000); }

async function api(path, opts){
  const r = await fetch(path, Object.assign({ headers:{'content-type':'application/json'} }, opts));
  if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('auth'); }
  const j = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(j.error || ('HTTP '+r.status));
  return j;
}

function showLogin(){ el('login').classList.remove('hidden'); el('app').classList.add('hidden'); }
function showApp(){ el('login').classList.add('hidden'); el('app').classList.remove('hidden'); }

async function doLogin(){
  el('loginErr').textContent='';
  try {
    await api('/login', { method:'POST', body: JSON.stringify({ password: el('pw').value }) });
    showApp(); await load();
  } catch(e){ el('loginErr').textContent = e.message==='Wrong password.'?'Неverный пароль':e.message; }
}
async function logout(){ await api('/logout',{method:'POST'}); showLogin(); }

async function load(){
  STATE = await api('/api/state');
  el('svc').innerHTML = STATE.service_loaded
    ? '<span class="ok">●</span> multiplexer запущен'
    : '<span class="warn">●</span> multiplexer не запущен';
  renderBots();
}

function renderBots(){
  const tb = el('bots').querySelector('tbody');
  tb.innerHTML = '';
  for (const b of STATE.bots){
    const tr = document.createElement('tr');
    const tok = b.token_present ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>';
    const access = b.allowed_chat_ids.length ? esc(b.allowed_chat_ids.join(', ')) : '<span class="muted">все</span>';
    tr.innerHTML =
      '<td><b>'+esc(b.name)+'</b></td>'+
      '<td>'+esc(b.provider)+'<br><span class="tag">'+esc(b.mode)+'</span></td>'+
      '<td>'+esc(b.agentOrModel)+'</td>'+
      '<td><span class="muted">'+esc(b.token_env)+'</span> '+tok+'</td>'+
      '<td>'+access+'</td>'+
      '<td>'+esc(b.effort)+'</td>'+
      '<td class="muted">'+esc(b.cwd||'')+'</td>'+
      '<td>'+(b.add_root_dir?'<span class="warn">on</span>':'<span class="muted">off</span>')+'</td>'+
      '<td style="white-space:nowrap"></td>';
    const td = tr.lastChild;
    const e = document.createElement('button'); e.className='ghost'; e.textContent='✎'; e.onclick=()=>editBot(b);
    const d = document.createElement('button'); d.className='danger'; d.textContent='🗑'; d.style.marginLeft='6px'; d.onclick=()=>delBot(b.name);
    td.appendChild(e); td.appendChild(d);
    tb.appendChild(tr);
  }
}

function fillSelect(sel, items, current){
  sel.innerHTML='';
  for (const it of items){
    const o=document.createElement('option'); o.value=it; o.textContent=it;
    if (it===current) o.selected=true; sel.appendChild(o);
  }
}

function onProvider(){
  const p = el('f_provider').value;
  const isClaudeOrCodex = (p==='claude-code'||p==='codex');
  el('agentBlock').classList.toggle('hidden', !isClaudeOrCodex);
  el('modelBlock').classList.toggle('hidden', isClaudeOrCodex);
  el('cwdBlock').classList.toggle('hidden', !isClaudeOrCodex);
  el('strangerBlock').classList.toggle('hidden', !isClaudeOrCodex);
  el('rootBlock').classList.toggle('hidden', !isClaudeOrCodex);
  el('codexAgentBlock').classList.toggle('hidden', p!=='codex');
  el('f_agentSelect').classList.toggle('hidden', p==='codex');
  el('agentLabel').classList.toggle('hidden', p==='codex');
  if (p==='claude-code') fillSelect(el('f_agentSelect'), STATE.sources.claudeAgents, el('f_agentSelect').value);
  if (p==='openrouter') fillSelect(el('f_model'), STATE.sources.openrouterModels, el('f_model').value);
  if (p==='ollama') fillSelect(el('f_model'), STATE.sources.ollamaModels, el('f_model').value);
  fillSelect(el('f_persona'), ['', ...STATE.sources.teyaAgents.map(a=>a.path)], el('f_persona').value);
}

function newBot(){
  el('formTitle').textContent='Новый бот';
  el('originalName').value='';
  el('f_name').value=''; el('f_token').value=''; el('f_provider').value='claude-code';
  el('f_bottoken').value=''; el('tokenState').textContent='';
  el('f_codexAgent').value=''; el('f_cwd').value=''; el('f_allowed').value='';
  el('f_stranger').value=''; el('f_root').checked=false; el('f_effort').value='medium';
  onProvider();
  el('form').classList.remove('hidden');
}

function editBot(b){
  el('formTitle').textContent='Редактировать: '+b.name;
  el('originalName').value=b.name;
  el('f_name').value=b.name; el('f_token').value=b.token_env||'';
  // Token field is WRITE-ONLY — we never receive the value, only token_present.
  el('f_bottoken').value='';
  el('tokenState').innerHTML = b.token_present
    ? '<span class="ok">✓</span> токен сохранён — оставь поле пустым, чтобы не менять'
    : '<span class="bad">✗</span> токена нет — вставь токен или укажи token_env';
  el('f_provider').value = b.mode==='claude-agent' ? 'claude-code' : (b.model?'openrouter':'openrouter');
  el('f_effort').value=b.effort; el('f_cwd').value=b.cwd||'';
  el('f_allowed').value=(b.allowed_chat_ids||[]).join('\\n');
  el('f_stranger').value=b.stranger_reply||''; el('f_root').checked=!!b.add_root_dir;
  el('f_codexAgent').value = b.mode==='claude-agent' ? (b.agent||'') : '';
  onProvider();
  if (b.mode==='claude-agent' && b.agent){ if(![...el('f_agentSelect').options].some(o=>o.value===b.agent)){ const o=document.createElement('option');o.value=b.agent;o.textContent=b.agent+' (не найден)';el('f_agentSelect').appendChild(o);} el('f_agentSelect').value=b.agent; }
  if (b.model){ if(![...el('f_model').options].some(o=>o.value===b.model)){ const o=document.createElement('option');o.value=b.model;o.textContent=b.model;el('f_model').appendChild(o);} el('f_model').value=b.model; }
  if (b.agentDir) el('f_persona').value=b.agentDir;
  el('form').classList.remove('hidden');
}

function closeForm(){ el('form').classList.add('hidden'); }

async function save(){
  const p = el('f_provider').value;
  const payload = {
    originalName: el('originalName').value || undefined,
    name: el('f_name').value, token_env: el('f_token').value, provider: p,
    // Write-only: only send a token if the owner typed one (blank = keep existing).
    token: el('f_bottoken').value.trim() || undefined,
    effort: el('f_effort').value,
    allowed_chat_ids: el('f_allowed').value.split('\\n').map(s=>s.trim()).filter(Boolean),
  };
  if (p==='claude-code'){ payload.agent = el('f_agentSelect').value; payload.cwd = el('f_cwd').value; payload.stranger_reply = el('f_stranger').value; payload.add_root_dir = el('f_root').checked; }
  else if (p==='codex'){ payload.agent = el('f_codexAgent').value; payload.cwd = el('f_cwd').value; payload.stranger_reply = el('f_stranger').value; payload.add_root_dir = el('f_root').checked; }
  else { payload.model = el('f_model').value; payload.agentDir = el('f_persona').value || undefined; }
  try {
    await api('/api/bots', { method:'POST', body: JSON.stringify(payload) });
    closeForm(); await load(); toast('Сохранено. Не забудь Reload service.');
  } catch(e){ toast(e.message, true); }
}

async function delBot(name){
  if (!confirm('Удалить бота "'+name+'"?')) return;
  try { await api('/api/bots/delete', { method:'POST', body: JSON.stringify({ name }) }); await load(); toast('Удалён.'); }
  catch(e){ toast(e.message, true); }
}

async function reload(){
  try { const r = await api('/api/reload', { method:'POST' }); toast(r.message); await load(); }
  catch(e){ toast(e.message, true); }
}

(async function init(){
  try { await load(); showApp(); }
  catch { showLogin(); }
})();
</script>
</body>
</html>`
