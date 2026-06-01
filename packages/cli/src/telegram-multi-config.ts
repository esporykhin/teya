/**
 * @description Loader for the Telegram multiplexer config (~/.teya/telegram.json).
 *  One process, many Bot-API bots, each mapped to its own agent (cwd / SOUL /
 *  AGENTS / provider / model / allowed chats). Tokens are referenced by env var
 *  name (token_env) so secrets never live in the JSON file.
 * @exports loadTelegramMultiConfig, resolveBotAgents, TelegramMultiBotEntry, ResolvedBot
 */
import { readFile, writeFile, rename, mkdir, readdir, stat } from 'fs/promises'
import { dirname, join } from 'path'

const CONFIG_DIR = join(process.env.HOME || process.env.USERPROFILE || '.', '.teya')
export const TELEGRAM_MULTI_CONFIG_FILE = join(CONFIG_DIR, 'telegram.json')
export const AGENTS_DIR = join(CONFIG_DIR, 'agents')

/** Expand a leading `~` / `~/...` to the process HOME. */
export function expandHome(p: string, home = process.env.HOME || process.env.USERPROFILE || ''): string {
  if (p === '~') return home || p
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

export interface TelegramMultiBotEntry {
  /** Stable, url-safe bot name (used as session-id segment + agent key). */
  name: string
  /**
   * Name of the env var holding this bot's Bot-API token (LEGACY fallback).
   * Optional now: a token entered in the web admin is stored encrypted in the
   * token-store keyed by bot `name`, and that store takes precedence over this.
   * A bot may omit `token_env` entirely if its token lives in the store.
   */
  token_env?: string
  /**
   * TEYA-NATIVE mode. Directory holding this bot's SOUL.md / AGENTS.md (the
   * teya agent persona). The host runs the teya agentLoop for this bot.
   * Mutually exclusive with `agent` (claude-agent mode).
   */
  agentDir?: string
  /**
   * CLAUDE-AGENT mode. Name of a Claude Code agent (~/.claude/agents/<name>.md).
   * When set, this bot is a pure transport to `claude --agent <name>` — all
   * brains/tools/memory live on the Claude Code side, teya stores nothing.
   * Mutually exclusive with `agentDir`.
   */
  agent?: string
  /** CLAUDE-AGENT mode: working directory for the claude process. */
  cwd?: string
  /** CLAUDE-AGENT mode: reply sent to non-allow-listed chats. */
  stranger_reply?: string
  /**
   * CLAUDE-AGENT mode: grant `--add-dir /` (whole-filesystem read). Defaults to
   * false (safe — agent scoped to its cwd). Set true only for owner agents that
   * genuinely need broad disk access.
   */
  add_root_dir?: boolean
  /** Allow-list of numeric chat ids. Empty/omitted = everyone allowed. */
  allowed_chat_ids?: Array<number | string>
  /** Optional per-bot model override (provider stays the global default). */
  model?: string
  /**
   * Reasoning effort for this bot's underlying model. Maps to a real
   * per-provider knob (claude `--effort`, codex `model_reasoning_effort`,
   * openrouter `reasoning.effort`). Omitted ⇒ DEFAULT_EFFORT ("medium").
   */
  effort?: BotEffort
  /**
   * Per-turn timeout in milliseconds for `claude --agent` subprocess.
   * Omitted ⇒ DEFAULT_TIMEOUT_MS (120 000 = 2 min). Set higher for agents
   * that run long MCP-heavy tasks.
   */
  timeout_ms?: number
}

/** Reasoning-effort levels exposed per bot. Default is "medium". */
export type BotEffort = 'low' | 'medium' | 'high'

/** Applied when a bot omits `effort`. */
export const DEFAULT_EFFORT: BotEffort = 'medium'

const VALID_EFFORTS: readonly BotEffort[] = ['low', 'medium', 'high']

/** Type guard — true iff `v` is a valid BotEffort string. */
export function isBotEffort(v: unknown): v is BotEffort {
  return typeof v === 'string' && (VALID_EFFORTS as readonly string[]).includes(v)
}

/**
 * Normalise a raw `effort` value to a BotEffort, defaulting to "medium" when
 * absent. Throws a user-facing error on an invalid value so a typo in the JSON
 * (or `--effort xhigh`) fails loudly instead of silently degrading to default.
 */
export function resolveEffort(raw: unknown, botName = ''): BotEffort {
  if (raw === undefined || raw === null) return DEFAULT_EFFORT
  if (!isBotEffort(raw)) {
    const who = botName ? `Bot "${botName}": ` : ''
    throw new Error(`${who}invalid effort ${JSON.stringify(raw)} — expected one of ${VALID_EFFORTS.join(', ')}.`)
  }
  return raw
}

export interface TelegramMultiConfig {
  bots: TelegramMultiBotEntry[]
}

export interface ResolvedBot {
  name: string
  token: string
  /** Teya-native mode: persona dir. Mutually exclusive with `claudeAgent`. */
  agentDir?: string
  /** Claude-agent mode: drives `claude --agent <name>`. */
  claudeAgent?: {
    agent: string
    cwd: string
    model?: string
    strangerReply?: string
    /** Grant `--add-dir /` (whole FS). Default false (scoped to cwd). */
    addRootDir?: boolean
    /** Reasoning effort → `claude --effort <level>`. Default "medium". */
    effort: BotEffort
    /** Per-turn timeout ms. Default DEFAULT_TIMEOUT_MS. */
    timeoutMs?: number
  }
  allowedChatIds?: number[]
  model?: string
  /** Reasoning effort for this bot. Always set (defaulted to "medium"). */
  effort: BotEffort
  /** Per-turn timeout ms for claude subprocess. */
  timeoutMs?: number
}

/** Default per-turn timeout for claude subprocesses (2 minutes). */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Read + validate ~/.teya/telegram.json. Throws on malformed config. */
export async function loadTelegramMultiConfig(path = TELEGRAM_MULTI_CONFIG_FILE): Promise<TelegramMultiConfig> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    throw new Error(`Telegram multiplexer config not found: ${path}. Create it with a {"bots": [...]} array.`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`)
  }
  const cfg = parsed as TelegramMultiConfig
  if (!cfg || !Array.isArray(cfg.bots) || cfg.bots.length === 0) {
    throw new Error(`${path} must contain a non-empty "bots" array.`)
  }
  for (const b of cfg.bots) {
    if (!b.name) throw new Error(`A bot entry in ${path} is missing "name".`)
    // token_env is now OPTIONAL: a bot's token may live encrypted in the
    // token-store (keyed by name). We can't check the store from this pure
    // config core, so we no longer reject a missing token_env here — resolveBots
    // decides (store first, then env) and skips a bot with neither.
    // Validate effort eagerly so a typo surfaces at load, not deep in a provider.
    resolveEffort(b.effort, b.name)
  }
  return cfg
}

/**
 * Telegram Bot-API token shape: `<bot_id>:<35-char-secret>`. We accept 30+ secret
 * chars to be forgiving of future format tweaks while still rejecting obvious
 * junk (env-var names, empty strings, an env-var NAME pasted by mistake).
 */
export const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/

/** True iff `value` looks like a real Bot-API token (id:secret). */
export function isValidBotToken(value: string): boolean {
  return BOT_TOKEN_RE.test(value.trim())
}

/**
 * Look up a bot's plaintext token from the encrypted token-store by bot name.
 * Returns null when there's no stored token (caller falls back to env). Inject
 * the real implementation (TokenStore.getToken) from the cli; defaults to "no
 * store" so the pure config tests can exercise the env-only path unchanged.
 */
export type TokenStoreLookup = (botName: string) => string | null

/**
 * Resolve each bot's token and normalise allowed chat ids. Token precedence:
 *   1. encrypted token-store (keyed by bot name)  — the new, preferred source
 *   2. `token_env` env var                         — legacy fallback
 * A bot with neither is skipped (logged) so one missing secret doesn't sink the
 * whole multiplexer. Enforces unique tokens (two pollers on one token => 409).
 */
export function resolveBots(
  cfg: TelegramMultiConfig,
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.warn,
  tokenStore: TokenStoreLookup = () => null,
): ResolvedBot[] {
  const resolved: ResolvedBot[] = []
  const seenTokens = new Set<string>()
  for (const b of cfg.bots) {
    // Store first (preferred), then env (legacy). Either may be absent.
    const stored = tokenStore(b.name)
    const token = stored ?? (b.token_env ? env[b.token_env] : undefined)
    if (!token) {
      const where = b.token_env
        ? `no token in store for "${b.name}" and env ${b.token_env} is not set`
        : `no token in store for "${b.name}" and no token_env configured`
      log(`[telegram-multi] Skipping bot "${b.name}": ${where}.`)
      continue
    }
    if (seenTokens.has(token)) {
      throw new Error(`[telegram-multi] Two bots resolve to the same token (would 409): "${b.name}".`)
    }
    seenTokens.add(token)
    const allowedChatIds = (b.allowed_chat_ids || [])
      .map((c) => Number(c))
      .filter((n) => Number.isFinite(n))
    if (b.agent && b.agentDir) {
      throw new Error(`[telegram-multi] Bot "${b.name}" sets both "agent" (claude-agent) and "agentDir" (teya-native) — pick one.`)
    }
    // Validate + default effort once; throws on an invalid value (typo guard).
    const effort = resolveEffort(b.effort, b.name)
    const claudeAgent = b.agent
      ? {
          agent: b.agent,
          cwd: expandHome(b.cwd || env.HOME || process.cwd(), env.HOME),
          model: b.model,
          strangerReply: b.stranger_reply,
          addRootDir: b.add_root_dir === true,
          effort,
          timeoutMs: typeof b.timeout_ms === 'number' ? b.timeout_ms : DEFAULT_TIMEOUT_MS,
        }
      : undefined
    resolved.push({
      name: b.name,
      token,
      agentDir: claudeAgent ? undefined : b.agentDir,
      claudeAgent,
      allowedChatIds: allowedChatIds.length ? allowedChatIds : undefined,
      model: b.model,
      effort,
      timeoutMs: typeof b.timeout_ms === 'number' ? b.timeout_ms : DEFAULT_TIMEOUT_MS,
    })
  }
  if (resolved.length === 0) {
    throw new Error('[telegram-multi] No bots could be resolved — check token_env vars are exported.')
  }
  return resolved
}

// ─── Config mutation (teya bots add/set-agent/remove) ────────────────────────
//
// The on-disk config has a `bots[]` array PLUS owner-authored keys we must not
// destroy: `_comment`, `_cutover_pending`, and whatever future scaffolding the
// owner drops in. So we model the raw file as an open record and only ever
// touch `bots`. Read-modify-write keeps every unknown top-level key intact, and
// writes go through a temp+rename so a crashed write never truncates the live
// file the launchd multiplexer reads on reload.

/** Raw shape of telegram.json: a `bots` array plus arbitrary owner keys. */
export type RawTelegramConfig = Record<string, unknown> & {
  bots?: TelegramMultiBotEntry[]
}

/**
 * Read the raw config object WITHOUT validation, preserving every key.
 * Returns `{ bots: [] }` if the file doesn't exist yet (first bot ever).
 * Unlike loadTelegramMultiConfig this never throws on an empty/absent bots
 * array — mutations need to operate on a partially-built config.
 */
export async function readRawConfig(path = TELEGRAM_MULTI_CONFIG_FILE): Promise<RawTelegramConfig> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return { bots: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}. Refusing to overwrite — fix it by hand first.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object. Refusing to overwrite.`)
  }
  const cfg = parsed as RawTelegramConfig
  if (cfg.bots !== undefined && !Array.isArray(cfg.bots)) {
    throw new Error(`${path} has a non-array "bots" key. Refusing to overwrite.`)
  }
  if (!cfg.bots) cfg.bots = []
  return cfg
}

/**
 * Atomically persist the raw config. Writes to a sibling temp file then
 * renames over the target — rename is atomic on the same filesystem, so a
 * reader (the launchd multiplexer) never sees a half-written file. All
 * non-`bots` keys the caller carried through are written back verbatim.
 */
export async function writeRawConfig(cfg: RawTelegramConfig, path = TELEGRAM_MULTI_CONFIG_FILE): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  const body = JSON.stringify(cfg, null, 2) + '\n'
  await writeFile(tmp, body, 'utf-8')
  await rename(tmp, path)
}

export interface AgentInfo {
  /** Folder name under ~/.teya/agents (the `--agent <name>` value). */
  name: string
  /** Absolute path to the agent directory. */
  path: string
  /** Which persona file(s) were found (SOUL.md / AGENTS.md). */
  files: string[]
}

/** True if `dir` holds a SOUL.md or AGENTS.md (i.e. is a real agent persona). */
export async function agentFilesIn(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const f of ['SOUL.md', 'AGENTS.md']) {
    try {
      const s = await stat(join(dir, f))
      if (s.isFile()) found.push(f)
    } catch {
      // missing — skip
    }
  }
  return found
}

/**
 * List agent personas under ~/.teya/agents — every subdirectory that holds a
 * SOUL.md and/or AGENTS.md. These are the candidates for `--agent <name>`.
 */
export async function listAgents(agentsDir = AGENTS_DIR): Promise<AgentInfo[]> {
  let entries: string[]
  try {
    entries = await readdir(agentsDir)
  } catch {
    return []
  }
  const out: AgentInfo[] = []
  for (const name of entries.sort()) {
    if (name.startsWith('.')) continue
    const dir = join(agentsDir, name)
    let isDir = false
    try {
      isDir = (await stat(dir)).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    const files = await agentFilesIn(dir)
    if (files.length > 0) out.push({ name, path: dir, files })
  }
  return out
}

/**
 * Resolve a `--agent <name>` / `--agent-dir <path>` pair to an absolute
 * agentDir, verifying it actually holds a persona file. Exactly one of the two
 * must be provided. Throws a user-facing error otherwise.
 */
export async function resolveAgentDir(
  opts: { agent?: string; agentDir?: string },
  agentsDir = AGENTS_DIR,
): Promise<string> {
  const { agent, agentDir } = opts
  if (agent && agentDir) {
    throw new Error('Pass either --agent <name> or --agent-dir <path>, not both.')
  }
  if (!agent && !agentDir) {
    throw new Error('Missing agent: pass --agent <name> (folder under ~/.teya/agents) or --agent-dir <path>.')
  }
  const dir = agentDir ? agentDir : join(agentsDir, agent!)
  const files = await agentFilesIn(dir)
  if (files.length === 0) {
    throw new Error(`Agent dir "${dir}" has no SOUL.md or AGENTS.md — not a valid agent persona.`)
  }
  return dir
}

/** Directory holding Claude Code agents (`claude --agent <name>` reads <name>.md). */
export const CLAUDE_AGENTS_DIR = join(process.env.HOME || process.env.USERPROFILE || '.', '.claude', 'agents')

export interface ClaudeAgentInfo {
  /** Agent name (the `--agent <name>` value; <name>.md basename). */
  name: string
  /** Absolute path to the <name>.md file. */
  path: string
}

/**
 * List Claude Code agents — every `<name>.md` directly under ~/.claude/agents.
 * These are the candidates for a claude-agent bot (`teya bots add --agent`).
 */
export async function listClaudeAgents(dir = CLAUDE_AGENTS_DIR): Promise<ClaudeAgentInfo[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const out: ClaudeAgentInfo[] = []
  for (const name of entries.sort()) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue
    const path = join(dir, name)
    try {
      if (!(await stat(path)).isFile()) continue
    } catch {
      continue
    }
    out.push({ name: name.slice(0, -3), path })
  }
  return out
}

/** True if a Claude Code agent `<name>.md` exists under ~/.claude/agents. */
export async function claudeAgentExists(name: string, dir = CLAUDE_AGENTS_DIR): Promise<boolean> {
  try {
    return (await stat(join(dir, `${name}.md`))).isFile()
  } catch {
    return false
  }
}

export interface AddBotInput {
  name: string
  /** LEGACY env-var name for this bot's token. Optional — token may be in the store. */
  token_env?: string
  /** Teya-native mode: persona dir (mutually exclusive with claudeAgent). */
  agentDir?: string
  /** Claude-agent mode (mutually exclusive with agentDir). */
  claudeAgent?: { agent: string; cwd?: string; stranger_reply?: string }
  allowed_chat_ids?: number[]
  model?: string
  /** Reasoning effort. Omitted ⇒ stored as-is (default "medium" applies on read). */
  effort?: BotEffort
}

/**
 * Add a bot→agent binding to the raw config, enforcing uniqueness of both
 * `name` and `token_env`. Two bots on one token would make Telegram 409 the
 * second poller (getUpdates conflict), so a duplicate token is a hard error —
 * this is the same 409-guard resolveBots/the transport enforce at startup,
 * moved earlier so the owner gets a clean message instead of a crashed daemon.
 * Mutates and returns `cfg`; caller persists via writeRawConfig.
 */
export function addBotEntry(cfg: RawTelegramConfig, input: AddBotInput): RawTelegramConfig {
  if (!input.name) throw new Error('Bot name is required (--name).')
  // token_env is OPTIONAL now — a bot whose token lives in the encrypted
  // token-store needs no env var. We only dup-guard token_env when present.
  if (input.agentDir && input.claudeAgent) {
    throw new Error('Pass either --agent-dir (teya-native) or --agent (claude-agent), not both.')
  }
  if (!input.agentDir && !input.claudeAgent) {
    throw new Error('Missing agent: pass --agent <claude-agent> or --agent-dir <teya-persona>.')
  }
  const bots = cfg.bots ?? (cfg.bots = [])
  if (bots.some((b) => b.name === input.name)) {
    throw new Error(`A bot named "${input.name}" already exists. Use \`teya bots set-agent\` to re-point it, or pick another name.`)
  }
  if (input.token_env && bots.some((b) => b.token_env === input.token_env)) {
    throw new Error(`token_env "${input.token_env}" is already bound to another bot. One token = one poller (Telegram 409s the second). Refusing to add.`)
  }
  const entry: TelegramMultiBotEntry = {
    name: input.name,
  }
  // Persist token_env only when given — a store-backed bot has no env var.
  if (input.token_env) entry.token_env = input.token_env
  if (input.claudeAgent) {
    entry.agent = input.claudeAgent.agent
    if (input.claudeAgent.cwd) entry.cwd = input.claudeAgent.cwd
    if (input.claudeAgent.stranger_reply) entry.stranger_reply = input.claudeAgent.stranger_reply
  } else {
    entry.agentDir = input.agentDir
  }
  if (input.allowed_chat_ids && input.allowed_chat_ids.length) entry.allowed_chat_ids = input.allowed_chat_ids
  if (input.model) entry.model = input.model
  // Persist effort only when it deviates from the default — a missing field
  // reads back as "medium", so writing "medium" is redundant noise in the file.
  if (input.effort !== undefined) {
    const effort = resolveEffort(input.effort, input.name)
    if (effort !== DEFAULT_EFFORT) entry.effort = effort
  }
  bots.push(entry)
  return cfg
}

/**
 * Set (or clear) the reasoning effort for an existing bot. `effort = undefined`
 * resets it to the default (drops the key). Throws on an unknown bot name or an
 * invalid effort value. Mutates and returns `cfg`; caller persists.
 */
export function setBotEffort(cfg: RawTelegramConfig, name: string, effort: BotEffort | undefined): RawTelegramConfig {
  const bots = cfg.bots ?? []
  const entry = bots.find((b) => b.name === name)
  if (!entry) {
    throw new Error(`No bot named "${name}". Run \`teya bots list\` to see current bindings.`)
  }
  if (effort === undefined) {
    delete entry.effort
    return cfg
  }
  const normalised = resolveEffort(effort, name)
  // Default is implied by the absence of the key — don't persist "medium".
  if (normalised === DEFAULT_EFFORT) delete entry.effort
  else entry.effort = normalised
  return cfg
}

/**
 * Re-point an existing bot at a different agent. Supports BOTH modes and never
 * silently mixes them:
 *   - { agentDir } → teya-native: sets agentDir, clears any `agent`/`cwd`.
 *   - { agent }    → claude-agent: sets agent (+optional cwd), clears `agentDir`.
 * Passing both or neither is an error. This prevents the M-1 footgun where a
 * claude-agent bot gets an `agentDir` slapped on it while keeping `agent`,
 * yielding an ambiguous entry resolveBots would reject.
 */
export function setBotAgent(
  cfg: RawTelegramConfig,
  name: string,
  target: { agentDir?: string; agent?: string; cwd?: string },
  model?: string,
): RawTelegramConfig {
  const bots = cfg.bots ?? []
  const entry = bots.find((b) => b.name === name)
  if (!entry) {
    throw new Error(`No bot named "${name}". Run \`teya bots list\` to see current bindings.`)
  }
  if (target.agentDir && target.agent) {
    throw new Error('Re-point to either a teya persona (--agent-dir) OR a claude agent (--agent), not both.')
  }
  if (!target.agentDir && !target.agent) {
    throw new Error('Nothing to set: pass --agent <claude-agent> or --agent-dir <teya-persona>.')
  }
  if (target.agent) {
    // claude-agent mode — drop any teya-native key so the entry is unambiguous.
    entry.agent = target.agent
    if (target.cwd) entry.cwd = target.cwd
    delete entry.agentDir
  } else {
    // teya-native mode — drop any claude-agent keys.
    entry.agentDir = target.agentDir
    delete entry.agent
    delete entry.cwd
    delete entry.stranger_reply
  }
  if (model !== undefined) {
    if (model) entry.model = model
    else delete entry.model
  }
  return cfg
}

/** Remove a bot binding by name. Throws if it isn't there. */
export function removeBotEntry(cfg: RawTelegramConfig, name: string): RawTelegramConfig {
  const bots = cfg.bots ?? []
  const idx = bots.findIndex((b) => b.name === name)
  if (idx === -1) {
    throw new Error(`No bot named "${name}". Run \`teya bots list\` to see current bindings.`)
  }
  bots.splice(idx, 1)
  return cfg
}
