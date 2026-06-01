/**
 * @description `teya bots <action>` — manage the bot→agent bindings for the
 *   Telegram multiplexer (~/.teya/telegram.json) without hand-editing JSON.
 *
 *   Owner flow: pick an agent persona (a folder with SOUL.md/AGENTS.md under
 *   ~/.teya/agents) and bind it to a bot token (referenced by env-var name), so
 *   different bots route to different agents. Each mutation is an atomic
 *   read-modify-write that preserves owner-authored keys (`_comment`,
 *   `_cutover_pending`) and then offers a launchd hot-reload so the change goes
 *   live without a manual restart.
 *
 * @exports runBotsSubcommand
 */
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import * as readline from 'readline'
import {
  TELEGRAM_MULTI_CONFIG_FILE,
  AGENTS_DIR,
  CLAUDE_AGENTS_DIR,
  readRawConfig,
  writeRawConfig,
  listAgents,
  listClaudeAgents,
  claudeAgentExists,
  resolveAgentDir,
  expandHome,
  addBotEntry,
  setBotAgent,
  setBotEffort,
  removeBotEntry,
  isBotEffort,
  DEFAULT_EFFORT,
} from './telegram-multi-config.js'
import type { TelegramMultiBotEntry, BotEffort } from './telegram-multi-config.js'

const LAUNCHD_LABEL = 'com.teya.telegram'

interface ParsedBotsArgs {
  /** Positional args after the action (e.g. the bot name for set-agent/remove). */
  positionals: string[]
  /** `--key value` string flags. */
  strings: Record<string, string>
  /** Repeatable `--allow <id>` values. */
  allow: number[]
  /** Boolean flags present without a value. */
  flags: Set<string>
}

/**
 * Parse `teya bots` args. Unlike the global parseArgs, this understands:
 *  - repeatable `--allow <id>` (collects into a list)
 *  - boolean flags `--reload`, `--json`, `--no-reload`
 *  - positionals (the bot name for set-agent/remove)
 */
function parseBotsArgs(argv: string[]): ParsedBotsArgs {
  const out: ParsedBotsArgs = { positionals: [], strings: {}, allow: [], flags: new Set() }
  const BOOL = new Set(['reload', 'no-reload', 'json', 'help'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out.positionals.push(a)
      continue
    }
    const key = a.slice(2)
    if (BOOL.has(key)) {
      out.flags.add(key)
      continue
    }
    const val = argv[i + 1]
    if (val === undefined || val.startsWith('--')) {
      // Treat a valueless unknown flag as boolean rather than swallowing the next flag.
      out.flags.add(key)
      continue
    }
    i++
    if (key === 'allow') {
      const n = Number(val)
      if (!Number.isFinite(n)) throw new Error(`--allow expects a numeric chat id, got "${val}".`)
      out.allow.push(n)
    } else {
      out.strings[key] = val
    }
  }
  return out
}

/**
 * Validate a `--effort <value>` flag. Returns the BotEffort, or undefined when
 * the flag is absent (caller applies the default). Throws on an invalid value
 * so `--effort xhigh` fails loudly instead of silently dropping to medium.
 */
export function parseEffortFlag(raw: string | undefined): BotEffort | undefined {
  if (raw === undefined) return undefined
  if (!isBotEffort(raw)) {
    throw new Error(`invalid --effort "${raw}" — expected one of low, medium, high.`)
  }
  return raw
}

/**
 * Best-effort check whether a token env var is populated, looking in
 * process.env first and then ~/.claude/credentials.env (the file the launchd
 * wrapper sources). Used only for a warning — a token absent here at CLI time
 * may still be present in the daemon's environment.
 */
async function tokenIsAvailable(tokenEnv: string): Promise<boolean> {
  if (process.env[tokenEnv]) return true
  const credsPath = join(process.env.HOME || '.', '.claude', 'credentials.env')
  if (!existsSync(credsPath)) return false
  try {
    const text = await readFile(credsPath, 'utf-8')
    const re = new RegExp(`^\\s*${tokenEnv}\\s*=\\s*(.+?)\\s*$`, 'm')
    const m = text.match(re)
    return !!(m && m[1].replace(/^["']|["']$/g, ''))
  } catch {
    return false
  }
}

/** Is the launchd multiplexer service loaded? (false ⇒ skip reload, don't error.) */
function launchdServiceLoaded(): boolean {
  const r = spawnSync('launchctl', ['list', LAUNCHD_LABEL], { encoding: 'utf-8' })
  return r.status === 0
}

function reloadCommandHint(): string {
  return `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`
}

/**
 * Hot-reload the multiplexer so the new config takes effect. Returns a status
 * line. Never throws — a missing service is normal (e.g. running teya by hand),
 * so we just tell the owner the manual command.
 */
function hotReload(): string {
  if (!launchdServiceLoaded()) {
    return `launchd service ${LAUNCHD_LABEL} not loaded — start the multiplexer yourself, or reload later with:\n  ${reloadCommandHint()}`
  }
  const uid = String(process.getuid?.() ?? '')
  const r = spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${LAUNCHD_LABEL}`], { encoding: 'utf-8' })
  if (r.status === 0) return `Reloaded ${LAUNCHD_LABEL} — new binding is live.`
  return `Reload failed (${r.stderr?.trim() || `exit ${r.status}`}). Run manually:\n  ${reloadCommandHint()}`
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (a) => { rl.close(); resolve(a.trim()) })
  })
}

/**
 * Decide whether to reload and do it. `--reload` ⇒ yes, `--no-reload` ⇒ no
 * (just print the hint), otherwise ask interactively. Always tells the owner
 * the manual command so they're never stuck.
 */
async function maybeReload(args: ParsedBotsArgs): Promise<void> {
  if (args.flags.has('no-reload')) {
    console.log(`\nSkipped reload. Apply later with:\n  ${reloadCommandHint()}`)
    return
  }
  let doReload = args.flags.has('reload')
  if (!doReload) {
    const ans = (await ask('\nHot-reload the multiplexer now so it takes effect? [y/N]: ')).toLowerCase()
    doReload = ans === 'y' || ans === 'yes'
  }
  if (doReload) {
    console.log(hotReload())
  } else {
    console.log(`Not reloaded. Apply later with:\n  ${reloadCommandHint()}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export async function runBotsSubcommand(action: string, argv: string[]): Promise<void> {
  let args: ParsedBotsArgs
  try {
    args = parseBotsArgs(argv)
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }

  if (args.flags.has('help')) {
    printHelp(action)
    return
  }

  switch (action) {
    case 'agents': return agentsCmd(args)
    case 'list':   return listCmd(args)
    case 'add':    return addCmd(args)
    case 'set-agent': return setAgentCmd(args)
    case 'set-effort': return setEffortCmd(args)
    case 'remove':
    case 'rm':     return removeCmd(args)
    case 'help':
    default:       printHelp()
  }
}

// ─── agents ──────────────────────────────────────────────────────────────────

async function agentsCmd(args: ParsedBotsArgs): Promise<void> {
  const teyaAgents = await listAgents()
  const claudeAgents = await listClaudeAgents()
  const cfg = await readRawConfig()
  const boundDirs = new Set((cfg.bots ?? []).map((b) => b.agentDir).filter(Boolean) as string[])
  const boundClaude = new Set((cfg.bots ?? []).map((b) => b.agent).filter(Boolean) as string[])

  if (args.flags.has('json')) {
    console.log(JSON.stringify({
      teya: teyaAgents.map((a) => ({ ...a, bound: boundDirs.has(a.path) })),
      claude: claudeAgents.map((a) => ({ ...a, bound: boundClaude.has(a.name) })),
    }, null, 2))
    return
  }

  // Claude Code agents (claude --agent <name>) — the primary mode now.
  console.log(`Claude Code agents in ${CLAUDE_AGENTS_DIR}:\n`)
  if (claudeAgents.length === 0) {
    console.log('  (none — create ~/.claude/agents/<name>.md)\n')
  } else {
    for (const a of claudeAgents) {
      const bound = boundClaude.has(a.name) ? '  \x1b[32m[bound]\x1b[0m' : ''
      console.log(`  \x1b[1m${a.name}\x1b[0m${bound}  \x1b[90m${a.path}\x1b[0m`)
    }
    console.log('')
  }

  // Teya-native personas (legacy mode).
  console.log(`Teya personas in ${AGENTS_DIR}:\n`)
  if (teyaAgents.length === 0) {
    console.log(`  (none — a folder with SOUL.md/AGENTS.md, e.g. ${join(AGENTS_DIR, 'my-agent')})`)
    return
  }
  for (const a of teyaAgents) {
    const bound = boundDirs.has(a.path) ? '  \x1b[32m[bound]\x1b[0m' : ''
    console.log(`  \x1b[1m${a.name}\x1b[0m${bound}`)
    console.log(`    \x1b[90m${a.path}  (${a.files.join(', ')})\x1b[0m`)
  }
}

// ─── list ────────────────────────────────────────────────────────────────────

async function listCmd(args: ParsedBotsArgs): Promise<void> {
  const cfg = await readRawConfig()
  const bots = cfg.bots ?? []
  const running = launchdServiceLoaded()

  if (args.flags.has('json')) {
    const enriched = await Promise.all(bots.map(async (b) => ({
      ...b,
      // Surface the EFFECTIVE effort (default applied) so consumers — including
      // a future admin UI — never have to re-implement the medium fallback.
      effort: b.effort ?? DEFAULT_EFFORT,
      token_present: await tokenIsAvailable(b.token_env),
    })))
    console.log(JSON.stringify({ bots: enriched, service_loaded: running }, null, 2))
    return
  }

  if (bots.length === 0) {
    console.log(`No bot bindings in ${TELEGRAM_MULTI_CONFIG_FILE}.`)
    console.log('Add one with: teya bots add --name <n> --token-env <ENV> --agent <agent>')
    return
  }
  console.log(`Bindings in ${TELEGRAM_MULTI_CONFIG_FILE}:`)
  console.log(`Multiplexer service ${LAUNCHD_LABEL}: ${running ? '\x1b[32mloaded\x1b[0m' : '\x1b[90mnot loaded\x1b[0m'}\n`)
  for (const b of bots) {
    const tokenOk = await tokenIsAvailable(b.token_env)
    const tokenMark = tokenOk ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
    const chats = b.allowed_chat_ids && b.allowed_chat_ids.length
      ? b.allowed_chat_ids.join(', ')
      : 'everyone'
    console.log(`  \x1b[1m${b.name}\x1b[0m`)
    if (b.agent) {
      console.log(`    mode:   claude-agent`)
      console.log(`    agent:  ${b.agent}  (cwd: ${b.cwd || '~'})`)
      if (b.stranger_reply) console.log(`    stranger: ${b.stranger_reply}`)
    } else {
      console.log(`    mode:   teya-native`)
      console.log(`    agent:  ${b.agentDir || '(teya default)'}`)
    }
    console.log(`    token:  ${b.token_env} ${tokenMark}`)
    console.log(`    chats:  ${chats}`)
    if (b.model) console.log(`    model:  ${b.model}`)
    console.log(`    effort: ${b.effort ?? DEFAULT_EFFORT}${b.effort ? '' : ' (default)'}`)
  }
}

// ─── add ─────────────────────────────────────────────────────────────────────

async function addCmd(args: ParsedBotsArgs): Promise<void> {
  const name = args.strings['name']
  const tokenEnv = args.strings['token-env']
  if (!name || !tokenEnv) {
    console.error('Usage: teya bots add --name <n> --token-env <ENV> (--agent <claude-agent> [--cwd <dir>] | --agent-dir <teya-persona>) [--allow <chatId> ...] [--model <m>] [--stranger-reply <text>] [--reload]')
    process.exit(1)
  }

  const claudeAgentName = args.strings['agent']      // claude-agent mode
  const teyaPersonaDir = args.strings['agent-dir']   // teya-native mode

  if (claudeAgentName && teyaPersonaDir) {
    console.error('Error: pass either --agent (claude-agent) or --agent-dir (teya-native), not both.')
    process.exit(1)
  }
  if (!claudeAgentName && !teyaPersonaDir) {
    console.error('Error: pass --agent <claude-agent> (from ~/.claude/agents) or --agent-dir <teya-persona>.')
    process.exit(1)
  }

  // Validate --effort up front so a typo fails before we touch the config.
  let effort: BotEffort | undefined
  try {
    effort = parseEffortFlag(args.strings['effort'])
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }

  let describe: string
  const addInput: Parameters<typeof addBotEntry>[1] = {
    name,
    token_env: tokenEnv,
    allowed_chat_ids: args.allow.length ? args.allow : undefined,
    model: args.strings['model'],
    effort,
  }

  if (claudeAgentName) {
    // CLAUDE-AGENT mode: validate the agent exists, default cwd to HOME.
    if (!(await claudeAgentExists(claudeAgentName))) {
      console.error(`Error: claude agent "${claudeAgentName}" not found (${join(CLAUDE_AGENTS_DIR, claudeAgentName + '.md')}). Run \`teya bots agents\` to list.`)
      process.exit(1)
    }
    const cwd = expandHome(args.strings['cwd'] || process.env.HOME || process.cwd())
    addInput.claudeAgent = {
      agent: claudeAgentName,
      cwd,
      stranger_reply: args.strings['stranger-reply'],
    }
    describe = `claude:${claudeAgentName} (cwd ${cwd})`
  } else {
    // TEYA-NATIVE mode: resolve the persona dir (must hold SOUL.md/AGENTS.md).
    let agentDir: string
    try {
      agentDir = await resolveAgentDir({ agentDir: teyaPersonaDir })
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`)
      process.exit(1)
    }
    addInput.agentDir = agentDir
    describe = agentDir
  }

  const cfg = await readRawConfig()
  try {
    addBotEntry(cfg, addInput)
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }

  await writeRawConfig(cfg)
  console.log(`Added bot "${name}" → ${describe}`)
  console.log(`  token_env: ${tokenEnv}`)
  if (args.allow.length) console.log(`  allowed chats: ${args.allow.join(', ')}`)
  if (args.strings['model']) console.log(`  model: ${args.strings['model']}`)
  console.log(`  effort: ${effort ?? DEFAULT_EFFORT}${effort ? '' : ' (default)'}`)
  if (args.strings['stranger-reply']) console.log(`  stranger reply: ${args.strings['stranger-reply']}`)

  if (!(await tokenIsAvailable(tokenEnv))) {
    console.log(`\n\x1b[33mWarning:\x1b[0m env ${tokenEnv} is not set in the shell or ~/.claude/credentials.env.`)
    console.log('The bot will be skipped at startup until the token is exported (the multiplexer sources credentials.env).')
  }

  await maybeReload(args)
}

// ─── set-agent ───────────────────────────────────────────────────────────────

async function setAgentCmd(args: ParsedBotsArgs): Promise<void> {
  const name = args.positionals[0]
  if (!name) {
    console.error('Usage: teya bots set-agent <name> (--agent <claude-agent> [--cwd <dir>] | --agent-dir <teya-persona>) [--model <m>] [--reload]')
    process.exit(1)
  }

  const claudeAgentName = args.strings['agent']
  const teyaPersonaDir = args.strings['agent-dir']
  if (claudeAgentName && teyaPersonaDir) {
    console.error('Error: pass either --agent (claude-agent) or --agent-dir (teya-native), not both.')
    process.exit(1)
  }
  if (!claudeAgentName && !teyaPersonaDir) {
    console.error('Error: pass --agent <claude-agent> or --agent-dir <teya-persona>.')
    process.exit(1)
  }

  let target: { agentDir?: string; agent?: string; cwd?: string }
  let describe: string
  if (claudeAgentName) {
    // CLAUDE-AGENT mode: validate the agent <name>.md exists. Keep this a
    // claude-agent bot — never silently convert it to a broken teya-native entry.
    if (!(await claudeAgentExists(claudeAgentName))) {
      console.error(`Error: claude agent "${claudeAgentName}" not found (${join(CLAUDE_AGENTS_DIR, claudeAgentName + '.md')}). Run \`teya bots agents\` to list.`)
      process.exit(1)
    }
    const cwd = args.strings['cwd'] ? expandHome(args.strings['cwd']) : undefined
    target = { agent: claudeAgentName, cwd }
    describe = `claude:${claudeAgentName}${cwd ? ` (cwd ${cwd})` : ''}`
  } else {
    // TEYA-NATIVE mode: resolve the persona dir (must hold SOUL.md/AGENTS.md).
    let agentDir: string
    try {
      agentDir = await resolveAgentDir({ agentDir: teyaPersonaDir })
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`)
      process.exit(1)
    }
    target = { agentDir }
    describe = agentDir
  }

  const cfg = await readRawConfig()
  try {
    setBotAgent(cfg, name, target, args.strings['model'])
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }
  await writeRawConfig(cfg)
  console.log(`Re-pointed bot "${name}" → ${describe}`)
  if (args.strings['model']) console.log(`  model: ${args.strings['model']}`)
  await maybeReload(args)
}

// ─── set-effort ──────────────────────────────────────────────────────────────

async function setEffortCmd(args: ParsedBotsArgs): Promise<void> {
  const name = args.positionals[0]
  if (!name) {
    console.error('Usage: teya bots set-effort <name> --effort <low|medium|high> [--reload]')
    process.exit(1)
  }
  const raw = args.strings['effort']
  if (raw === undefined) {
    console.error('Error: --effort <low|medium|high> is required.')
    process.exit(1)
  }
  let effort: BotEffort
  try {
    effort = parseEffortFlag(raw)!
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }

  const cfg = await readRawConfig()
  try {
    setBotEffort(cfg, name, effort)
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }
  await writeRawConfig(cfg)
  console.log(`Set effort for bot "${name}" → ${effort}`)
  await maybeReload(args)
}

// ─── remove ──────────────────────────────────────────────────────────────────

async function removeCmd(args: ParsedBotsArgs): Promise<void> {
  const name = args.positionals[0]
  if (!name) {
    console.error('Usage: teya bots remove <name> [--reload]')
    process.exit(1)
  }
  const cfg = await readRawConfig()
  let removed: TelegramMultiBotEntry | undefined = (cfg.bots ?? []).find((b) => b.name === name)
  try {
    removeBotEntry(cfg, name)
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }
  await writeRawConfig(cfg)
  console.log(`Removed bot "${name}"${removed?.token_env ? ` (was bound to ${removed.token_env})` : ''}.`)
  await maybeReload(args)
}

// ─── help ────────────────────────────────────────────────────────────────────

function printHelp(action?: string): void {
  if (action === 'add') {
    console.log(`teya bots add — bind a bot token to an agent

Two modes (pick one):
  CLAUDE-AGENT (recommended): --agent <name>  → pure transport to \`claude --agent <name>\`
                              (reads ~/.claude/agents/<name>.md; brains/memory on Claude side)
  TEYA-NATIVE  (legacy):      --agent-dir <path>  → teya persona dir (SOUL.md/AGENTS.md), runs teya agentLoop

Usage:
  teya bots add --name <n> --token-env <ENV> (--agent <name> [--cwd <dir>] | --agent-dir <path>) [options]

Required:
  --name <n>          Unique bot name (session-id segment + agent key)
  --token-env <ENV>   Env var holding this bot's Bot-API token (e.g. TEYA_TG_BOT_TOKEN)
  --agent <name>      Claude Code agent (~/.claude/agents/<name>.md)  [claude-agent mode]
  --agent-dir <path>  Teya persona dir with SOUL.md/AGENTS.md         [teya-native mode]

Options:
  --cwd <dir>         Working dir for the claude process (claude-agent mode; default \$HOME)
  --stranger-reply <text>  Reply for non-allow-listed chats (claude-agent mode)
  --allow <chatId>    Allow-list a numeric chat id (repeatable). Omit = everyone.
  --model <m>         Per-bot model override (e.g. opus, sonnet)
  --effort <level>    Reasoning effort: low | medium | high  (default medium)
  --reload            Hot-reload the multiplexer after writing (no prompt)
  --no-reload         Skip reload, just print the manual command

Example (CEO bot — claude-agent):
  teya bots add --name ceo --token-env SOLOPRENEURO_TG_BOT_TOKEN \\
    --agent solopreneuro-ceo --cwd ~/projects/solopreneuro --allow 112833890`)
    return
  }
  console.log(`teya bots — manage Telegram bot→agent bindings (${TELEGRAM_MULTI_CONFIG_FILE})

Commands:
  agents                          List agent personas under ~/.teya/agents (marks bound ones)
  list                            Show current bot→agent bindings + token/run status
  add --name … --token-env … …    Bind a bot token to an agent  (see: teya bots add --help)
  set-agent <name> --agent …      Re-point an existing bot at another agent
  set-effort <name> --effort …    Set reasoning effort (low|medium|high) for a bot
  remove <name>                   Remove a bot binding

Global flags:
  --json        Machine-readable output (agents, list)
  --reload      Hot-reload the multiplexer after a mutation
  --no-reload   Skip reload, print the manual reload command
  --help        Per-command help

Hot-reload command (launchd):
  ${reloadCommandHint()}`)
}
