#!/usr/bin/env node
/**
 * @description Main entry point — wires all packages together, onboarding, config, slash commands
 * @exports CLITransport, main
 */
import * as readline from 'readline'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { agentLoop, buildSystemPrompt } from '@teya/core'
import { loadSkills, buildSkillsMetadata, buildActiveSkillContent, buildVerifiedSkillsCatalog } from '@teya/skills'
import type { Message, LLMProvider, MessageContext } from '@teya/core'
import { openrouter, ollama, codex, withToolAdapter, fallback } from '@teya/providers'
import { createToolRegistry, registerBuiltins, createMCPManager, createDynamicToolLoader, closeBrowser, initWorkspace, getWorkspaceInfo } from '@teya/tools'
import { AgentRegistry, createDelegateTool } from '@teya/orchestrator'
import { CLITransport } from '@teya/transport-cli'
import { TelegramTransport, TelegramUserbotTransport, createTelegramTool } from '@teya/transport-telegram'
import { SessionStore, KnowledgeGraphRegistry, createMemoryTools, AssetStoreRegistry, createAssetTools, ollamaEmbeddings } from '@teya/memory'
import type { SessionState } from '@teya/core'
import { AgentTracer, consoleExporter, jsonExporter, sessionFileExporter, compositeExporter, GenerationEnricher } from '@teya/tracing'
import { TaskStore, createTaskTools, ensureSchedulerRunning } from '@teya/scheduler'
import {
  register as registerProcess,
  list as listProcesses,
  stop as stopProcess,
  restartAll as restartAllProcesses,
} from '@teya/runtime'
import { DataStoreRegistry, createDataTools } from '@teya/data'
import {
  runWithIdentity,
  makeIdentityContext,
  type Identity,
  type IdentityContext,
} from '@teya/core'

const CONFIG_DIR = join(process.env.HOME || process.env.USERPROFILE || '.', '.teya')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

async function loadSavedConfig(): Promise<Record<string, string>> {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8')
    return JSON.parse(data)
  } catch {
    return {}
  }
}

async function saveConfig(config: Record<string, string>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
}

function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

async function interactiveSetup(): Promise<{ provider: string; model: string; apiKey: string }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  console.log('\n\x1b[1mTeya — First Run Setup\x1b[0m\n')
  console.log('Let\'s configure your AI provider.\n')

  console.log('Providers:')
  console.log('  1. OpenRouter (recommended — access to all models with one API key)')
  console.log('     Get your key at: https://openrouter.ai/keys')
  console.log('  2. Ollama (local models, no API key required)')
  console.log('     Install at: https://ollama.com')
  console.log('  3. Codex (OpenAI Codex CLI — runs as subprocess)')
  console.log('     Install: npm i -g @openai/codex\n')

  const providerChoice = await ask(rl, 'Provider (1, 2, or 3)', '1')
  const isOllama = providerChoice.trim() === '2'
  const isCodex = providerChoice.trim() === '3'

  const provider = isCodex ? 'codex' : isOllama ? 'ollama' : 'openrouter'
  const defaultModel = isCodex ? '' : isOllama ? 'qwen3:8b' : 'google/gemini-2.0-flash-001'
  const model = await ask(rl, `Model${isCodex ? ' (empty for codex default)' : ''}`, defaultModel)

  let apiKey = ''
  if (!isOllama && !isCodex) {
    apiKey = await ask(rl, 'API Key (OpenRouter)')
  }

  rl.close()

  if (!isOllama && !isCodex && !apiKey) {
    console.error('\nAPI key is required. Get one at https://openrouter.ai/keys')
    process.exit(1)
  }

  // Save for next time
  await saveConfig({ provider, model, apiKey })
  console.log(`\n\x1b[32mConfig saved to ${CONFIG_FILE}\x1b[0m\n`)

  return { provider, model, apiKey }
}

// Check for subcommands before main agent loop
const subcommand = process.argv[2]

// teya telegram login | logout | status | doctor
if (subcommand === 'telegram') {
  const action = process.argv[3] || 'help'
  const { runTelegramSubcommand } = await import('./telegram-cli.js')
  await runTelegramSubcommand(action, process.argv.slice(4), {
    configFile: CONFIG_FILE,
    loadSavedConfig,
    saveConfig,
  })
  process.exit(0)
}

if (subcommand === 'skill') {
  const action = process.argv[3]
  const target = process.argv[4]

  if (action === 'add' && target) {
    try {
      const { installSkill } = await import('@teya/skills')
      const result = await installSkill(target)
      console.log(`Installed skill: ${result.name}`)
      console.log(`Location: ${result.path}`)
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
    }
    process.exit(0)
  }

  if (action === 'list') {
    const { listInstalledSkills } = await import('@teya/skills')
    const skills = listInstalledSkills()
    if (skills.length === 0) {
      console.log('No skills installed.')
    } else {
      for (const s of skills) console.log(`  ${s.name} — ${s.path}`)
    }
    process.exit(0)
  }

  if (action === 'verified') {
    const { listVerifiedSkills } = await import('@teya/skills')
    const skills = await listVerifiedSkills()
    if (skills.length === 0) {
      console.log('No verified skills available.')
    } else {
      console.log('Verified skills:')
      for (const s of skills) {
        const skill = s as typeof s & { audience?: string; domains?: string[] }
        const meta: string[] = []
        if (skill.category) meta.push(`category: ${skill.category}`)
        if (skill.audience) meta.push(`audience: ${skill.audience}`)
        if (skill.domains && skill.domains.length > 0) meta.push(`domains: ${skill.domains.join(', ')}`)
        if (skill.tags.length > 0) meta.push(`tags: ${skill.tags.join(', ')}`)
        console.log(`  ${skill.slug} — ${skill.description}${meta.length > 0 ? ` [${meta.join(' | ')}]` : ''}`)
      }
      console.log('\nInstall with: teya skill add verified:<name>')
    }
    process.exit(0)
  }

  if (action === 'remove' && target) {
    const { removeSkill } = await import('@teya/skills')
    if (removeSkill(target)) {
      console.log(`Removed skill: ${target}`)
    } else {
      console.log(`Skill not found: ${target}`)
    }
    process.exit(0)
  }

  console.log('Usage:')
  console.log('  teya skill add <source>    Install a skill (verified:<name>, github:user/repo, URL, or local path)')
  console.log('  teya skill list            List installed skills')
  console.log('  teya skill verified        List curated verified skills bundled with Teya')
  console.log('  teya skill remove <name>   Remove a skill')
  process.exit(0)
}

// Self-update subcommand
if (subcommand === 'update') {
  const { selfUpdate } = await import('./self-update.js')
  const result = await selfUpdate((msg) => console.log(msg))
  if (result.success) {
    if (result.needsRestart) {
      console.log(`\n\x1b[32mUpdated successfully: ${result.beforeRef} -> ${result.afterRef}\x1b[0m`)
      console.log(`${result.changes.length} new commits:`)
      for (const c of result.changes.slice(0, 10)) console.log(`  ${c}`)
      if (result.changes.length > 10) console.log(`  ... and ${result.changes.length - 10} more`)
    } else {
      console.log('\x1b[32mAlready up to date.\x1b[0m')
    }
  } else {
    console.error(`\x1b[31mUpdate failed: ${result.error}\x1b[0m`)
    process.exit(1)
  }
  process.exit(0)
}

// Scheduler subcommand
if (subcommand === 'scheduler') {
  const { handleSchedulerCommand } = await import('@teya/scheduler')
  await handleSchedulerCommand(process.argv.slice(3))
  process.exit(0)
}

// Trace viewer subcommand — read-only inspection of jsonl traces.
// Decoupled from the main agent boot path so it doesn't open DBs / providers.
if (subcommand === 'trace') {
  const { handleTraceCommand } = await import('./trace-cli.js')
  await handleTraceCommand(process.argv.slice(3))
  process.exit(0)
}

// Runtime registry — list / restart background teya processes.
// All logic lives in @teya/runtime; this is just CLI UX.
if (subcommand === 'runtime') {
  const action = process.argv[3] || 'list'
  if (action === 'list' || action === 'ls') {
    const procs = listProcesses()
    if (procs.length === 0) {
      console.log('No background teya processes registered.')
    } else {
      console.log(`${procs.length} registered process(es):\n`)
      for (const p of procs) {
        const age = Math.floor((Date.now() - new Date(p.startedAt).getTime()) / 1000)
        const ageStr = age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`
        const beat = Math.floor((Date.now() - new Date(p.lastHeartbeat).getTime()) / 1000)
        console.log(`  ${p.id.padEnd(20)} pid=${String(p.pid).padEnd(7)} up=${ageStr.padEnd(6)} beat=${beat}s  ${p.description}`)
        console.log(`  ${' '.repeat(20)} log: ${p.logFile}`)
      }
    }
  } else if (action === 'stop') {
    const id = process.argv[4]
    if (!id) { console.error('Usage: teya runtime stop <id>'); process.exit(1) }
    const ok = await stopProcess(id)
    console.log(ok ? `Stopped ${id}` : `${id} was not running`)
  } else if (action === 'restart') {
    const restarted = await restartAllProcesses({ log: (msg) => console.log(msg) })
    console.log(`\nRestarted ${restarted.length} process(es).`)
  } else {
    console.log(`teya runtime — manage background teya processes

Commands:
  list                List registered processes with heartbeat age
  stop <id>           Gracefully stop one process
  restart             Restart all registered processes`)
  }
  process.exit(0)
}

// teya eval run <suite.yaml>
if (subcommand === 'eval') {
  const action = process.argv[3]
  const suitePath = process.argv[4]

  if (action === 'run' && suitePath) {
    const { loadEvalSuite, runEvalSuite, formatResults } = await import('@teya/eval')
    const { createToolRegistry, registerBuiltins, initWorkspace, getWorkspaceRoot } = await import('@teya/tools')
    const { openrouter, ollama, withToolAdapter } = await import('@teya/providers')
    const { buildSystemPrompt } = await import('@teya/core')
    const { KnowledgeGraph, createMemoryTools } = await import('@teya/memory')
    const { TaskStore, createTaskTools } = await import('@teya/scheduler')
    const { DataStore, createDataTools } = await import('@teya/data')

    const saved = await loadSavedConfig()
    const provType = process.argv.find(a => a === '--provider')
      ? process.argv[process.argv.indexOf('--provider') + 1]
      : saved.provider || 'openrouter'
    const model = process.argv.find(a => a === '--model')
      ? process.argv[process.argv.indexOf('--model') + 1]
      : saved.model || 'google/gemini-2.0-flash-001'
    const apiKey = saved.apiKey || process.env.OPENROUTER_API_KEY || ''

    const provider = provType === 'ollama'
      ? withToolAdapter(ollama({ model }))
      : openrouter({ model, apiKey })

    await initWorkspace()
    const toolRegistry = createToolRegistry()
    registerBuiltins(toolRegistry)

    const kg = new KnowledgeGraph()
    const memTools = createMemoryTools(kg)
    toolRegistry.register(memTools.memoryTool)

    const taskStore = new TaskStore()
    const taskTools = createTaskTools(taskStore)
    toolRegistry.register(taskTools.tasksTool)
    toolRegistry.register(taskTools.scheduleTool)

    const dataStore = new DataStore(join(process.env.HOME || '.', '.teya', 'data.db'), 'teya')
    const dataTools = createDataTools(dataStore)
    toolRegistry.register(dataTools.dataTool)

    const systemPrompt = await buildSystemPrompt({ agentDir: process.cwd() })
    const suite = await loadEvalSuite(suitePath)

    console.log(`\nEval: ${suite.name} (${suite.cases.length} cases)`)
    console.log(`Model: ${provType}/${model}\n`)

    const { getWorkspaceRoot: getWR } = await import('@teya/tools')
    const results = await runEvalSuite(suite, {
      provider,
      toolRegistry: toolRegistry as any,
      systemPrompt,
      workspaceRoot: getWR(),
    })

    console.log(formatResults(results))
    kg.close()
    taskStore.close()
    process.exit(results.every(r => r.passed) ? 0 : 1)
  }

  console.log('Usage: teya eval run <suite.yaml> [--provider openrouter] [--model google/gemini-2.0-flash-001]')
  process.exit(0)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const saved = await loadSavedConfig()

  let providerType = args['provider'] ?? process.env.TEYA_PROVIDER ?? saved.provider ?? ''
  let model = args['model'] ?? process.env.TEYA_MODEL ?? saved.model ?? ''
  let apiKey = args['api-key'] ?? process.env.OPENROUTER_API_KEY ?? process.env.TEYA_API_KEY ?? saved.apiKey ?? ''

  // If no config — interactive setup
  if (!apiKey && providerType !== 'ollama' && providerType !== 'codex') {
    const setup = await interactiveSetup()
    providerType = setup.provider
    model = setup.model
    apiKey = setup.apiKey
  }

  if (!providerType) providerType = 'openrouter'
  if (!model) model = providerType === 'ollama' ? 'qwen3:8b' : 'google/gemini-2.0-flash-001'

  // Codex sandbox mode from config/CLI/env
  const codexSandbox = (args['codex-sandbox'] ?? process.env.CODEX_SANDBOX ?? (saved as any).codex?.sandbox ?? 'workspace-write') as 'read-only' | 'workspace-write' | 'danger-full-access'
  const codexFullAuto = codexSandbox !== 'danger-full-access'

  // Helper: instantiate a provider by type
  function makeProvider(type: string, mdl: string, key: string, baseUrl?: string): LLMProvider {
    if (type === 'openrouter') return openrouter({ model: mdl, apiKey: key })
    if (type === 'ollama') return withToolAdapter(ollama({ model: mdl, baseUrl }))
    if (type === 'codex') return codex({ model: mdl || undefined, cwd: process.cwd(), sandbox: codexSandbox, fullAuto: codexFullAuto })
    console.error(`Unknown provider: ${type}. Supported: openrouter, ollama, codex`)
    process.exit(1)
  }

  // Create primary provider
  let provider: LLMProvider = makeProvider(providerType, model, apiKey, args['base-url'])

  // Forward declare so the fallback onFallback callback can reach the tracer
  // — tracer itself is created later (after provider, since it needs caps).
  // We assign once both exist via this holder.
  const tracerHolder: { current: AgentTracer | null } = { current: null }

  // Wrap with fallback if configured
  const fallbackType = args['fallback'] ?? process.env.TEYA_FALLBACK ?? (saved as any).fallback?.provider ?? ''
  if (fallbackType) {
    const fallbackModel = args['fallback-model'] ?? (saved as any).fallback?.model ?? ''
    const fallbackKey = args['fallback-api-key'] ?? (saved as any).fallback?.apiKey ?? apiKey
    const fb = makeProvider(fallbackType, fallbackModel, fallbackKey)
    provider = fallback([provider, fb], {
      retries: 1,
      onFallback: (from, to, err) => {
        console.log(`\x1b[33m[fallback] ${from} failed: ${err.message}\x1b[0m`)
        console.log(`\x1b[33m[fallback] switching to ${to}\x1b[0m`)
        // Pipe into the trace stream so post-mortem analysis can spot
        // sessions where the user got a degraded model silently.
        tracerHolder.current?.processEvent({
          type: 'provider_fallback',
          from,
          to,
          error: err.message,
        })
      },
    })
  }

  // Create tracer. By default we write BOTH a per-session jsonl (for fast
  // `teya trace show <id>` lookup) and a daily aggregate (for cost rollups).
  // Disable with --tracing none. Override with --tracing console|otlp.
  const tracingMode = (args['tracing'] || 'json') as string
  let tracer: AgentTracer | null = null
  const tracerConfig = { capabilities: provider.capabilities }
  if (tracingMode === 'console') {
    tracer = new AgentTracer(consoleExporter, tracerConfig)
    tracerHolder.current = tracer
  } else if (tracingMode === 'json') {
    const today = new Date().toISOString().slice(0, 10)
    const dailyPath = args['trace-file'] || join(CONFIG_DIR, 'traces', `${today}.jsonl`)
    const sessionsDir = join(CONFIG_DIR, 'traces', 'sessions')
    const exporter = compositeExporter(jsonExporter(dailyPath), sessionFileExporter(sessionsDir))
    tracer = new AgentTracer(exporter, tracerConfig)
    tracerHolder.current = tracer
    console.log(`\x1b[90mTracing: ${dailyPath} + sessions/<id>.jsonl\x1b[0m`)
  } else if (tracingMode === 'otlp') {
    const { otlpExporter } = await import('@teya/tracing')
    const endpoint = args['otlp-endpoint'] || 'http://localhost:4318/v1/traces'
    tracer = new AgentTracer(otlpExporter(endpoint), tracerConfig)
    tracerHolder.current = tracer
    console.log(`\x1b[90mTracing OTLP to ${endpoint}\x1b[0m`)
  }
  // tracingMode === 'none' (or anything else) → tracer stays null

  // Enricher: backfills authoritative billing details (real cost, cached
  // tokens, provider name) by polling provider.getGenerationDetails() in the
  // background. Decoupled from agent loop so we never block on it.
  const enricher = tracer && provider.getGenerationDetails
    ? new GenerationEnricher(provider, tracer)
    : null

  // Initialize workspace (sandboxed directory for agent file operations)
  const workspaceRoot = await initWorkspace()
  console.log(`\x1b[90mWorkspace: ${workspaceRoot}\x1b[0m`)

  // Create tool registry
  const toolRegistry = createToolRegistry()
  registerBuiltins(toolRegistry)

  // Load sub-agents
  const agentRegistry = new AgentRegistry()
  await agentRegistry.loadFromDirectory(join(CONFIG_DIR, 'agents'))
  const subAgents = agentRegistry.list()
  if (subAgents.length > 0) console.log(`\x1b[90m${subAgents.length} agents available\x1b[0m`)

  // Register delegate tool
  toolRegistry.register(createDelegateTool(agentRegistry, provider, tracer ?? undefined))

  // Initialize knowledge graph and register memory tools
  // Try to use Ollama for local embeddings — fall back to keyword-only if unavailable
  let embeddingProvider = undefined
  try {
    const testResponse = await fetch('http://localhost:11434/api/tags')
    if (testResponse.ok) {
      embeddingProvider = ollamaEmbeddings()
      console.log('\x1b[90mEmbeddings: Ollama (local)\x1b[0m')
    }
  } catch {
    // Ollama not available — keyword search only
  }
  // Per-identity registries: each scope (owner / guest-tg-789 / etc) gets
  // its own knowledge graph, asset store, and data store. Tools resolve
  // the active store via AsyncLocalStorage on every call — no per-message
  // re-registration. Filesystem-level isolation prevents cross-scope leaks.
  const kgRegistry = new KnowledgeGraphRegistry(embeddingProvider)
  const memTools = createMemoryTools(kgRegistry)
  toolRegistry.register(memTools.memoryTool)  // core:memory

  const assetRegistry = new AssetStoreRegistry()
  const assetTools = createAssetTools(assetRegistry)
  toolRegistry.register(assetTools.assetTool)  // core:assets

  // Tasks/scheduler stay single-instance — they're owner-only by permission
  // engine fence (guests cannot schedule background work on the host).
  const taskStore = new TaskStore()
  const taskTools = createTaskTools(taskStore)
  toolRegistry.register(taskTools.tasksTool)     // core:tasks
  toolRegistry.register(taskTools.scheduleTool)  // core:schedule

  const dataRegistry = new DataStoreRegistry('teya')
  const dataTools = createDataTools(dataRegistry)
  toolRegistry.register(dataTools.dataTool)      // core:data

  process.on('exit', () => {
    kgRegistry.closeAll()
    assetRegistry.closeAll()
    taskStore.close()
    dataRegistry.closeAll()
  })

  // Connect MCP server if --mcp flag is provided
  const mcpManager = createMCPManager()
  const mcpServer = args['mcp']
  if (mcpServer) {
    const [command, ...mcpArgs] = mcpServer.split(' ')
    try {
      await mcpManager.connectServer({ command, args: mcpArgs }, toolRegistry)
    } catch (err: unknown) {
      console.error(`[MCP] Failed to connect: ${err instanceof Error ? err.message : err}`)
    }
  }

  // Cleanup MCP connections and browser on exit
  process.on('SIGINT', () => {
    Promise.all([mcpManager.disconnectAll(), closeBrowser()]).finally(() => process.exit(0))
  })

  // Create dynamic tool loader — sync tool list after all tools are registered
  const toolLoader = createDynamicToolLoader()
  toolLoader.setTools(toolRegistry.list())

  // Load skills from cwd/skills/ and ~/.teya/skills/
  const localSkills = await loadSkills(join(process.cwd(), 'skills'))
  const globalSkills = await loadSkills(join(CONFIG_DIR, 'skills'))
  const allSkills = [...localSkills, ...globalSkills]
  if (allSkills.length > 0) console.log(`\x1b[90m${allSkills.length} skill${allSkills.length === 1 ? '' : 's'} loaded\x1b[0m`)

  // Build skills content for system prompt:
  // if few skills (<5) — include full bodies; otherwise just metadata
  const skillsMetadata = buildSkillsMetadata(allSkills)
  const activeSkillContent = allSkills.length > 0 && allSkills.length < 5
    ? buildActiveSkillContent(allSkills)
    : ''
  const verifiedSkillsCatalog = await buildVerifiedSkillsCatalog()

  // Build system prompt (reads SOUL.md / AGENTS.md from cwd if present)
  const systemPrompt = await buildSystemPrompt({
    agentDir: process.cwd(),
    skillsMetadata: [skillsMetadata, verifiedSkillsCatalog].filter(Boolean).join('\n\n') || undefined,
    activeSkillContent: activeSkillContent || undefined,
  }) + '\n\n' + getWorkspaceInfo()

  // Transport type (needed for session creation)
  const transportType = args['transport'] || 'cli'

  // Session store for persistence
  const sessionStore = new SessionStore()

  /**
   * Per-route session state. Each composite Telegram sessionId
   * (e.g. "tg:123:t456") owns its own currentSession + conversationHistory
   * + tools/agents tracking. CLI mode has exactly one entry. Telegram mode
   * can have N concurrent entries (one per topic / per author / per chat).
   *
   * Without this map, two different Telegram topics would race to overwrite
   * the same currentSession.messages and one would lose messages.
   */
  interface RouteState {
    /** Underlying SessionState row from sessions.db */
    session: SessionState
    /** In-memory replay buffer — flushed to disk via sessionStore.save() */
    history: Message[]
    toolsUsed: Set<string>
    agentsUsed: Set<string>
    taskIds: Set<string>
  }
  const routes = new Map<string, RouteState>()

  /**
   * Resolve (or create) the RouteState for a given route id. The id can
   * be undefined for legacy/CLI flows — in that case we resume the latest
   * session in the DB. For Telegram-style ids ("tg:123:t456"), we look up
   * the session by id and resume, or create a new one if missing.
   */
  async function getOrLoadRoute(routeId: string | undefined): Promise<RouteState> {
    // Single-session "anchor" for CLI mode — anchored on the latest row
    // at startup. For Telegram, every distinct routeId becomes its own slot.
    const key = routeId || '__cli__'
    const cached = routes.get(key)
    if (cached) return cached

    let session: SessionState | null = null
    if (routeId) {
      // Try to find a saved session whose id contains the routeId in its
      // metadata (we use routeId as session.id directly when creating).
      session = await sessionStore.load(routeId)
    } else {
      session = await sessionStore.getLatest()
    }

    if (!session) {
      // Create a new row. For Telegram routes the row id IS the routeId,
      // so resuming on the next message is O(1).
      session = sessionStore.createSession('default', transportType)
      if (routeId) {
        // Replace the auto-generated UUID with the routeId so the saved
        // session is keyed by route, not by random UUID.
        session = { ...session, id: routeId }
        await sessionStore.save(session)
      }
    }

    const state: RouteState = {
      session,
      history: [...session.messages],
      toolsUsed: new Set(session.toolsUsed || []),
      agentsUsed: new Set(session.agentsUsed || []),
      taskIds: new Set(session.taskIds || []),
    }
    routes.set(key, state)
    return state
  }

  /**
   * Resolve who the current message comes from. CLI = always owner;
   * Telegram = check the sender's user id against the saved owner mapping
   * and either upgrade to owner or treat as a sandboxed guest.
   *
   * Owner mapping lives in ~/.teya/config.json under owner.telegramUserId
   * (set with --owner-telegram-id or by editing the file).
   */
  function resolveIdentity(ctx: MessageContext): IdentityContext {
    if (transportType === 'cli') {
      return makeIdentityContext({ kind: 'owner', label: 'admin' })
    }
    if (!ctx.sender) {
      // Telegram channels don't expose a sender — treat as anonymous.
      return makeIdentityContext({ kind: 'anonymous' })
    }
    const ownerTgId = (saved as Record<string, string>).ownerTelegramUserId || process.env.TEYA_OWNER_TG_ID
    if (ownerTgId && ctx.sender.id === ownerTgId) {
      return makeIdentityContext({ kind: 'owner', label: 'admin' })
    }
    const identity: Identity = {
      kind: 'guest',
      userId: ctx.sender.id,
      displayName: ctx.sender.displayName,
      username: ctx.sender.username,
      transport: transportType,
    }
    return makeIdentityContext(identity)
  }

  /**
   * On the first message from a new identity, write a starter person
   * entity into THEIR memory so Teya immediately "knows" who she's
   * talking to. Idempotent — only fires when the entity doesn't exist.
   */
  function rememberIdentityIfNew(idCtx: IdentityContext, ctx: MessageContext): void {
    if (idCtx.identity.kind !== 'guest') return
    if (!ctx.sender) return
    try {
      const kg = kgRegistry.for(idCtx.scopeId)
      const entityName = ctx.sender.displayName || ctx.sender.username || `tg-${ctx.sender.id}`
      const existing = kg.getEntity(entityName)
      if (existing) return
      const entityId = kg.addEntity(entityName, 'person')
      const facts: string[] = []
      facts.push(`${entityName} is a Telegram user (id: ${ctx.sender.id}) who reached out via Teya's bot.`)
      if (ctx.sender.username) facts.push(`${entityName}'s Telegram username is @${ctx.sender.username}.`)
      if (ctx.chat?.title) facts.push(`First seen in chat "${ctx.chat.title}".`)
      // Fire-and-forget — addFact is async because of embeddings.
      Promise.all(facts.map(f => kg.addFact(entityId, f, ['auto', 'first-contact']))).catch(() => {})
    } catch {
      // Memory write failures must not block the conversation.
    }
  }

  // Bootstrap: resume the latest session for CLI mode (Telegram mode loads
  // routes lazily on first message in each topic/chat).
  const bootstrapRoute = await getOrLoadRoute(undefined)
  console.log(
    `\x1b[90mSession ${bootstrapRoute.session.id.slice(0, 8)} — resuming (${bootstrapRoute.history.length} messages)\x1b[0m`,
  )

  // Seed the tracer with the bootstrap session's attributes. The tracer's
  // setContext() is called fresh on each message in the message handler.
  tracer?.setContext({
    sessionId: bootstrapRoute.session.id,
    agentId: bootstrapRoute.session.agentId || 'default',
    transport: transportType,
  })

  /** Reset a single route — used by /clear. Removes the in-memory entry and
   *  creates a fresh empty session for the same routeId. */
  async function resetRoute(routeId: string | undefined): Promise<RouteState> {
    const key = routeId || '__cli__'
    routes.delete(key)
    // Force creation of a fresh session row for this routeId.
    let session = sessionStore.createSession('default', transportType)
    if (routeId) {
      session = { ...session, id: routeId }
      await sessionStore.save(session)
    }
    const state: RouteState = {
      session,
      history: [],
      toolsUsed: new Set(),
      agentsUsed: new Set(),
      taskIds: new Set(),
    }
    routes.set(key, state)
    toolLoader.resetSession()
    tracer?.resetForNewSession(state.session.id)
    return state
  }

  // Create transport
  const telegramToken = args['telegram-token'] || process.env.TELEGRAM_BOT_TOKEN || saved.telegramToken || ''

  let transport: CLITransport | TelegramTransport | TelegramUserbotTransport
  const transportKind = transportType as 'cli' | 'telegram' | 'telegram-userbot'
  const isTelegramAny = transportKind === 'telegram' || transportKind === 'telegram-userbot'
  // True if this teya instance runs as a long-lived background process and
  // should be tracked in @teya/runtime so `teya update` can restart it.
  const isBackgroundProcess = isTelegramAny

  if (transportKind === 'telegram') {
    if (!telegramToken) {
      console.error('Telegram token required. Use --telegram-token or set TELEGRAM_BOT_TOKEN')
      process.exit(1)
    }
    transport = new TelegramTransport({ token: telegramToken })
  } else if (transportKind === 'telegram-userbot') {
    const apiIdRaw = args['telegram-api-id'] || process.env.TELEGRAM_API_ID || saved.telegramApiId || ''
    const apiHash = args['telegram-api-hash'] || process.env.TELEGRAM_API_HASH || saved.telegramApiHash || ''
    const sessionString = args['telegram-session'] || process.env.TELEGRAM_SESSION || saved.telegramUserbotSession || ''
    const allowedRaw = args['telegram-allowed-chats'] || process.env.TELEGRAM_ALLOWED_CHATS || saved.telegramAllowedChats || ''
    const triggerPrefix = args['telegram-trigger'] || process.env.TELEGRAM_TRIGGER || saved.telegramTrigger || ''

    if (!apiIdRaw || !apiHash) {
      console.error('Telegram userbot requires --telegram-api-id and --telegram-api-hash (get them at https://my.telegram.org/apps).')
      console.error('You can also set TELEGRAM_API_ID / TELEGRAM_API_HASH or save them in ~/.teya/config.json.')
      process.exit(1)
    }
    const apiId = Number(apiIdRaw)
    if (!Number.isFinite(apiId)) {
      console.error(`Invalid --telegram-api-id: ${apiIdRaw}`)
      process.exit(1)
    }

    const allowedChatIds = allowedRaw
      ? allowedRaw.split(',').map((s: string) => s.trim()).filter(Boolean)
      : undefined

    transport = new TelegramUserbotTransport({
      apiId,
      apiHash,
      sessionString: sessionString || undefined,
      allowedChatIds,
      triggerPrefix: triggerPrefix || undefined,
      onSession: async (newSession: string) => {
        const cur = await loadSavedConfig()
        cur.telegramApiId = String(apiId)
        cur.telegramApiHash = apiHash
        cur.telegramUserbotSession = newSession
        if (allowedRaw) cur.telegramAllowedChats = allowedRaw
        if (triggerPrefix) cur.telegramTrigger = triggerPrefix
        await saveConfig(cur)
        console.log(`\x1b[32m[telegram-userbot] Session saved to ${CONFIG_FILE}\x1b[0m`)
      },
    })
  } else {
    transport = new CLITransport()
    // Pass agent list for @mention autocomplete
    ;(transport as CLITransport).setAgents(
      subAgents.map(a => ({ id: a.id, description: a.description }))
    )
  }

  // Register this process in the runtime registry if it's a background mode.
  // Single point of registration — adding a new background transport later
  // means updating isBackgroundProcess above, not scattering register() calls.
  if (isBackgroundProcess) {
    const description = transportKind === 'telegram'
      ? 'Telegram bot (HTTP API)'
      : transportKind === 'telegram-userbot'
        ? 'Telegram userbot (MTProto)'
        : `${transportKind} background process`
    registerProcess(transportKind, description)
  }

  // When the userbot transport is active, give the agent full Telegram control
  // via the core:telegram tool — reuses the same authenticated MTProto client.
  if (transportKind === 'telegram-userbot') {
    const { resolveWorkspacePath, getWorkspaceRoot } = await import('@teya/tools')
    toolRegistry.register(
      createTelegramTool((transport as TelegramUserbotTransport).client, {
        resolvePath: (p, mode) => resolveWorkspacePath(p, mode),
        workspaceRoot: getWorkspaceRoot(),
      }),
    )
    toolLoader.setTools(toolRegistry.list())
  }

  let abortController: AbortController | null = null

  if (!isTelegramAny) {
    (transport as CLITransport).onCommand(async (command: string) => {
      switch (command) {
        case '/help': {
          console.log('\nCommands:')
          const cmds: [string, string][] = [
            ['/clear',   'New session + clear screen'],
            ['/stop',    'Cancel current task'],
            ['/status',  'Session info'],
            ['/tools',   'List available tools'],
            ['/memory',  'Memory stats'],
            ['/model',   'Show/change model'],
            ['/help',    'Show commands'],
            ['/compact', 'Clear context (keep session)'],
            ['/update',  'Update to latest version'],
            ['/exit',    'Exit Teya'],
          ]
          for (const [name, desc] of cmds) {
            console.log(`  \x1b[36m${name.padEnd(12)}\x1b[0m \x1b[90m${desc}\x1b[0m`)
          }
          console.log('')
          break
        }

        case '/clear': {
          const fresh = await resetRoute(undefined)
          ;(transport as CLITransport).setSessionId(fresh.session.id)
          console.clear()
          console.log('\x1b[1mTeya\x1b[0m')
          console.log(`\x1b[90mNew session ${fresh.session.id.slice(0, 8)}. Type / for commands.\x1b[0m\n`)
          break
        }

        case '/exit': {
          // Drain any pending billing lookups so the trace files contain
          // authoritative cost data before we leave. OpenRouter's
          // /generation endpoint can take 30-60s to surface fresh ids.
          if (enricher) {
            console.log('\x1b[90mFlushing trace enricher (up to 60s)...\x1b[0m')
            await enricher.drain(60_000)
            enricher.stop()
          }
          // Close the session-rollup span so the per-session jsonl ends
          // with a single agent.session row containing final totals.
          tracer?.finishSession('exit')
          console.log('\x1b[90mGoodbye.\x1b[0m')
          process.exit(0)
        }

        case '/tools':
          console.log('\nAvailable tools:')
          for (const name of toolRegistry.listNames()) {
            console.log(`  ${name}`)
          }
          console.log('')
          break

        case '/model': {
          console.log(`\nCurrent: ${providerType} / ${model}`)
          const rl = (await import('readline')).createInterface({ input: process.stdin, output: process.stdout })
          const newModel = await new Promise<string>(resolve => {
            rl.question('New model (empty to keep): ', answer => {
              rl.close()
              resolve(answer.trim())
            })
          })
          if (newModel) {
            model = newModel
            if (providerType === 'openrouter') {
              provider = openrouter({ model, apiKey })
            } else if (providerType === 'ollama') {
              provider = withToolAdapter(ollama({ model }))
            } else if (providerType === 'codex') {
              provider = codex({ model: model || undefined, cwd: process.cwd() })
            }
            const saved = await loadSavedConfig()
            saved.model = model
            await saveConfig(saved)
            console.log(`\x1b[32mModel changed to: ${model}\x1b[0m\n`)
          } else {
            console.log('')
          }
          break
        }

        case '/status': {
          const cur = await getOrLoadRoute(undefined)
          console.log(`\nSession: ${cur.session.id.slice(0, 8)}`)
          console.log(`Messages: ${cur.history.length}`)
          console.log(`Turns: ${cur.history.filter(m => m.role === 'assistant').length}`)
          console.log(`Total turns: ${cur.session.totalTurns}`)
          if (routes.size > 1) console.log(`Active routes: ${routes.size}`)
          console.log('')
          break
        }

        case '/memory': {
          try {
            // CLI command always views the OWNER scope's memory.
            const ownerKg = kgRegistry.for('owner')
            const entities = ownerKg.listEntities()
            console.log(`\nMemory: ${entities.length} entities`)
            for (const e of entities.slice(0, 5)) {
              const facts = ownerKg.getEntityFacts(e.id)
              console.log(`  ${e.name} (${e.type}): ${facts.length} facts`)
            }
            if (entities.length > 5) console.log(`  ... and ${entities.length - 5} more`)
            console.log('')
          } catch {
            console.log('\nMemory: not initialized\n')
          }
          break
        }

        case '/compact': {
          const cur = await getOrLoadRoute(undefined)
          cur.history = []
          cur.session = { ...cur.session, messages: [] }
          await sessionStore.save(cur.session)
          console.log('\x1b[90mContext cleared. Session preserved.\x1b[0m\n')
          break
        }

        case '/update': {
          console.log('')
          const { selfUpdate, restartProcess } = await import('./self-update.js')
          const result = await selfUpdate((msg) => console.log(`\x1b[90m${msg}\x1b[0m`))
          if (result.success) {
            if (result.needsRestart && result.entryPoint) {
              console.log(`\n\x1b[32mUpdated: ${result.beforeRef} -> ${result.afterRef} (${result.changes.length} commits)\x1b[0m`)
              for (const c of result.changes.slice(0, 5)) console.log(`  \x1b[90m${c}\x1b[0m`)
              if (result.changes.length > 5) console.log(`  \x1b[90m... and ${result.changes.length - 5} more\x1b[0m`)

              // Restart any background teya processes (Telegram bot, scheduler).
              // They keep the OLD code in RAM until killed — without this, the
              // disk binary is fresh but the running bot serves stale code.
              const others = listProcesses().filter(p => p.pid !== process.pid)
              if (others.length > 0) {
                console.log(`\n\x1b[90mRestarting ${others.length} background process(es)...\x1b[0m`)
                await restartAllProcesses({
                  excludePid: process.pid,
                  log: (msg) => console.log(`\x1b[90m${msg}\x1b[0m`),
                })
              }

              console.log('\n\x1b[90mRestarting self...\x1b[0m\n')
              // Close databases before restart
              kgRegistry.closeAll(); assetRegistry.closeAll(); taskStore.close(); dataRegistry.closeAll()
              await mcpManager.disconnectAll()
              await closeBrowser()
              restartProcess(result.entryPoint)
            } else {
              console.log('\x1b[32mAlready up to date.\x1b[0m\n')
            }
          } else {
            console.log(`\x1b[31mUpdate failed: ${result.error}\x1b[0m\n`)
          }
          break
        }

        default:
          console.log(`\nUnknown command: ${command}. Type /help\n`)
      }
    })
  }

  transport.onMessage(async (message, ctx) => {
    abortController = new AbortController()
    const routeKey = isBackgroundProcess ? ctx.sessionId : undefined

    // Resolve identity FIRST — every downstream operation (memory, files,
    // permissions, system prompt) is identity-scoped. We then run the rest
    // of the handler inside runWithIdentity so AsyncLocalStorage carries
    // the identity through awaits and tool executions.
    const idCtx = resolveIdentity(ctx)

    await runWithIdentity(idCtx, async () => {
      // Slash command intercept — works for ALL transports.
      const trimmed = message.trim()
      if (trimmed.startsWith('/')) {
        const cmd = trimmed.split(/\s+/)[0]
        if (cmd === '/clear' || cmd === '/new') {
          const fresh = await resetRoute(routeKey)
          const note = `New session ${fresh.session.id.slice(0, 8)}.`
          if (isTelegramAny) transport.send({ type: 'response', content: note }, ctx.sessionId)
          else { console.clear(); console.log('\x1b[1mTeya\x1b[0m'); console.log(`\x1b[90m${note}\x1b[0m\n`); (transport as CLITransport).prompt() }
          return
        }
        if (cmd === '/compact') {
          const cur = await getOrLoadRoute(routeKey)
          cur.history = []
          cur.session = { ...cur.session, messages: [] }
          await sessionStore.save(cur.session)
          const note = 'Context cleared. Session preserved.'
          if (isTelegramAny) transport.send({ type: 'response', content: note }, ctx.sessionId)
          else { console.log(`\x1b[90m${note}\x1b[0m\n`); (transport as CLITransport).prompt() }
          return
        }
        if (cmd === '/status') {
          const cur = await getOrLoadRoute(routeKey)
          const tokens = Math.ceil(cur.history.reduce((s, m) => s + (m.content?.length || 0), 0) / 3.5)
          const note = `session=${cur.session.id.slice(0, 8)} messages=${cur.history.length} ~tokens=${tokens} turns=${cur.session.totalTurns} cost=$${(cur.session.totalCost || 0).toFixed(4)} identity=${idCtx.identity.kind}/${idCtx.scopeId}`
          if (isTelegramAny) transport.send({ type: 'response', content: note }, ctx.sessionId)
          else { console.log(`\x1b[90m${note}\x1b[0m\n`); (transport as CLITransport).prompt() }
          return
        }
      }

      // Auto-record the person on first contact (guests only).
      rememberIdentityIfNew(idCtx, ctx)

      // Resolve the route — per-topic / per-author isolated session state.
      const route = await getOrLoadRoute(routeKey)

      // Vision model auto-switch when images are attached
      let activeProvider = provider
      const images = ctx.images
      if (images && images.length > 0) {
        const visionMap: Record<string, string> = {
          'z-ai/glm-5-turbo': 'z-ai/glm-5v-turbo',
          'z-ai/glm-5': 'z-ai/glm-5v-turbo',
          'z-ai/glm-4.6': 'z-ai/glm-4.6v',
          'z-ai/glm-4.5': 'z-ai/glm-4.5v',
        }
        const visionModel = visionMap[model] || 'google/gemini-2.5-flash-preview-05-20'
        if (visionModel !== model) {
          console.log(`\x1b[90m  Vision: ${visionModel}\x1b[0m`)
          activeProvider = openrouter({ model: visionModel, apiKey })
        }
      }

      // In groups, prefix the message with sender attribution so the LLM
      // can distinguish authors in multi-user threads. In private chats /
      // CLI, message is left untouched.
      let effectiveMessage = message
      if (ctx.sender && ctx.chat && ctx.chat.kind !== 'private' && ctx.chat.kind !== 'cli') {
        const author = ctx.sender.displayName || (ctx.sender.username && '@' + ctx.sender.username) || `user-${ctx.sender.id}`
        effectiveMessage = `[from: ${author}] ${message}`
      }

      // Compose an identity-aware system prompt. Owner gets the standard
      // promot; guests get a sandboxed-mode preamble explicitly telling
      // the model "you are not the owner, isolate per-user, never leak
      // owner data". The base systemPrompt + getWorkspaceInfo() add the
      // current scope's workspace path automatically (workspace.ts is
      // identity-aware).
      const guestPreamble = idCtx.identity.kind === 'guest'
        ? `\n\n## Identity & Privacy
You are talking to ${ctx.sender?.displayName || 'a user'} via Telegram (id: ${ctx.sender?.id}).
This user is NOT the administrator. They are a sandboxed guest.

Rules:
- All memory you write is stored in THIS user's private knowledge graph.
- Never share information about the administrator or other users.
- Never reference projects, plans, or facts that belong to the administrator.
- You have a personal workspace for this user where you can read/write files.
- You cannot execute shell commands or access the host machine.
- Help them with their own questions, projects, and creative work.\n`
        : ''
      const ownerPreamble = idCtx.identity.kind === 'owner' && transportType !== 'cli' && ctx.sender
        ? `\n\n## Identity\nYou are talking to your administrator (${ctx.sender.displayName || ctx.sender.username || ctx.sender.id}) via Telegram. Full trust.\n`
        : ''
      const effectiveSystemPrompt = systemPrompt + guestPreamble + ownerPreamble + '\n\n' + getWorkspaceInfo()

      // Stamp per-message trace context.
      tracer?.setContext({
        sessionId: route.session.id,
        agentId: route.session.agentId || 'default',
        transport: transportType,
        userMessage: message.slice(0, 500),
      })

      try {
        const events = agentLoop(
          {
            provider: activeProvider,
            toolRegistry,
            toolLoader,
            systemPrompt: effectiveSystemPrompt,
            config: { maxTurns: 50, maxCostPerSession: 5 },
            hooks: {},
          },
          effectiveMessage,
          route.history,
          abortController?.signal,
          images,
        )

        for await (const event of events) {
          tracer?.processEvent(event)

          if (event.type === 'thinking_end' && event.generationId && enricher) {
            enricher.enqueue(event.generationId, tracer!.getContext())
          }

          if (event.type === 'tool_start') {
            route.toolsUsed.add(event.tool)
            if (event.tool === 'core:task_create' || event.tool === 'core:task_update') {
              const taskId = (event.args as any)?.id
              if (taskId) route.taskIds.add(taskId)
            }
            if (event.tool === 'core:delegate') {
              const agentId = (event.args as any)?.agent
              if (agentId && agentId !== 'list') route.agentsUsed.add(agentId)
            }
          }

          if (event.type === 'messages_updated') {
            route.history = [...event.messages]
            route.session = {
              ...route.session,
              messages: route.history,
              updatedAt: new Date(),
              totalTurns: route.session.totalTurns + 1,
              totalCost: tracer?.getSessionCost() || route.session.totalCost,
              toolsUsed: [...route.toolsUsed],
              agentsUsed: [...route.agentsUsed],
              taskIds: [...route.taskIds],
            }
            await sessionStore.save(route.session)
          } else {
            transport.send(event, ctx.sessionId)
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`\nFatal error: ${msg}`)
      } finally {
        abortController = null
        if (!isTelegramAny) (transport as CLITransport).prompt()
      }
    })
  })

  transport.onCancel((_sessionId) => {
    abortController?.abort()
  })

  // Auto-bootstrap the scheduler daemon. The daemon registers itself in
  // @teya/runtime — no proxy registration from here. Idempotent: returns the
  // existing PID if a healthy daemon is already running. Opt out with
  // --no-scheduler. Skipped entirely when no cron tasks exist.
  const noScheduler = args['no-scheduler'] !== undefined
  const cronTasks = taskStore.listCronTasks()
  if (!noScheduler && cronTasks.length > 0) {
    const result = await ensureSchedulerRunning({ silent: true })
    if (result) {
      const tag = result.alreadyRunning ? 'attached' : 'started'
      console.log(`\x1b[90mScheduler: ${cronTasks.length} cron tasks, ${tag} (PID ${result.pid})\x1b[0m`)
    } else {
      console.log(`\x1b[33mScheduler: ${cronTasks.length} cron tasks but daemon failed to start (~/.teya/logs/scheduler.stderr.log)\x1b[0m`)
    }
  } else if (cronTasks.length > 0) {
    console.log(`\x1b[90mScheduler: ${cronTasks.length} cron tasks (auto-start disabled by --no-scheduler)\x1b[0m`)
  }

  await transport.start()
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      const key = argv[i].slice(2)
      result[key] = argv[i + 1]
      i++
    }
  }
  return result
}

main().catch(console.error)
