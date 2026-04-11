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
import type { Message, LLMProvider } from '@teya/core'
import { openrouter, ollama, codex, withToolAdapter, fallback } from '@teya/providers'
import { createToolRegistry, registerBuiltins, createMCPManager, createDynamicToolLoader, closeBrowser, initWorkspace, getWorkspaceInfo } from '@teya/tools'
import { AgentRegistry, createDelegateTool } from '@teya/orchestrator'
import { CLITransport } from '@teya/transport-cli'
import { TelegramTransport, TelegramUserbotTransport, createTelegramTool } from '@teya/transport-telegram'
import { SessionStore, KnowledgeGraph, createMemoryTools, AssetStore, createAssetTools, ollamaEmbeddings } from '@teya/memory'
import type { SessionState } from '@teya/core'
import { AgentTracer, consoleExporter, jsonExporter } from '@teya/tracing'
import { TaskStore, createTaskTools, HealthManager } from '@teya/scheduler'
import { DataStore, createDataTools } from '@teya/data'

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
      },
    })
  }

  // Create tracer based on --tracing flag (early, so it can be passed to delegate tool)
  const tracingMode = args['tracing'] || ''
  let tracer: AgentTracer | null = null
  const tracerConfig = { capabilities: provider.capabilities }
  if (tracingMode === 'console') {
    tracer = new AgentTracer(consoleExporter, tracerConfig)
  } else if (tracingMode === 'json') {
    const tracePath = args['trace-file'] || join(CONFIG_DIR, 'traces', `${Date.now()}.jsonl`)
    tracer = new AgentTracer(jsonExporter(tracePath), tracerConfig)
    console.log(`\x1b[90mTracing to ${tracePath}\x1b[0m`)
  } else if (tracingMode === 'otlp') {
    const { otlpExporter } = await import('@teya/tracing')
    const endpoint = args['otlp-endpoint'] || 'http://localhost:4318/v1/traces'
    tracer = new AgentTracer(otlpExporter(endpoint), tracerConfig)
    console.log(`\x1b[90mTracing OTLP to ${endpoint}\x1b[0m`)
  }

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
  const kg = new KnowledgeGraph(undefined, embeddingProvider)
  const memTools = createMemoryTools(kg)
  toolRegistry.register(memTools.memoryTool)  // core:memory (read, write, search, entities, relate, update)

  // Initialize asset store and register asset tools
  const assetStore = new AssetStore()
  const assetTools = createAssetTools(assetStore)
  toolRegistry.register(assetTools.assetTool)  // core:assets (save, search, get)

  // Initialize task store and register task tools
  const taskStore = new TaskStore()
  const taskTools = createTaskTools(taskStore)
  toolRegistry.register(taskTools.tasksTool)     // core:tasks (create, list, update, get, delete)
  toolRegistry.register(taskTools.scheduleTool)  // core:schedule (list, pause, resume, trigger, delete)

  // Initialize data store and register data tools
  const dataStore = new DataStore(join(CONFIG_DIR, 'data.db'), 'teya')
  const dataTools = createDataTools(dataStore)
  toolRegistry.register(dataTools.dataTool)      // core:data (create_table, insert, upsert, list, schema, sql, ...)

  process.on('exit', () => { kg.close(); assetStore.close(); taskStore.close(); dataStore.close() })

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

  // Per-session conversation history
  let conversationHistory: Message[] = []
  let currentSession: SessionState

  // Try to resume latest session on startup
  const latestSession = await sessionStore.getLatest()
  if (latestSession) {
    conversationHistory = [...latestSession.messages]
    currentSession = latestSession
    console.log(`\x1b[90mSession ${latestSession.id.slice(0, 8)} — resuming (${latestSession.messages.length} messages)\x1b[0m`)
  } else {
    currentSession = sessionStore.createSession('default', transportType)
    console.log(`\x1b[90mSession ${currentSession.id.slice(0, 8)}\x1b[0m`)
  }

  // Track metadata during session
  const sessionToolsUsed = new Set<string>(currentSession.toolsUsed || [])
  const sessionAgentsUsed = new Set<string>(currentSession.agentsUsed || [])
  const sessionTaskIds = new Set<string>(currentSession.taskIds || [])

  // Create transport
  const telegramToken = args['telegram-token'] || process.env.TELEGRAM_BOT_TOKEN || saved.telegramToken || ''

  let transport: CLITransport | TelegramTransport | TelegramUserbotTransport
  const transportKind = transportType as 'cli' | 'telegram' | 'telegram-userbot'
  const isTelegramAny = transportKind === 'telegram' || transportKind === 'telegram-userbot'

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
          currentSession = sessionStore.createSession()
          conversationHistory = []
          toolLoader.resetSession()
          ;(transport as CLITransport).setSessionId(currentSession.id)
          console.clear()
          console.log('\x1b[1mTeya\x1b[0m')
          console.log(`\x1b[90mNew session ${currentSession.id.slice(0, 8)}. Type / for commands.\x1b[0m\n`)
          break
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

        case '/status':
          console.log(`\nSession: ${currentSession.id.slice(0, 8)}`)
          console.log(`Messages: ${conversationHistory.length}`)
          console.log(`Turns: ${conversationHistory.filter(m => m.role === 'assistant').length}`)
          console.log(`Total turns: ${currentSession.totalTurns}\n`)
          break

        case '/memory': {
          try {
            const entities = kg.listEntities()
            console.log(`\nMemory: ${entities.length} entities`)
            for (const e of entities.slice(0, 5)) {
              const facts = kg.getEntityFacts(e.id)
              console.log(`  ${e.name} (${e.type}): ${facts.length} facts`)
            }
            if (entities.length > 5) console.log(`  ... and ${entities.length - 5} more`)
            console.log('')
          } catch {
            console.log('\nMemory: not initialized\n')
          }
          break
        }

        case '/compact':
          conversationHistory = []
          console.log('\x1b[90mContext cleared. Session preserved.\x1b[0m\n')
          break

        case '/update': {
          console.log('')
          const { selfUpdate, restartProcess } = await import('./self-update.js')
          const result = await selfUpdate((msg) => console.log(`\x1b[90m${msg}\x1b[0m`))
          if (result.success) {
            if (result.needsRestart && result.entryPoint) {
              console.log(`\n\x1b[32mUpdated: ${result.beforeRef} -> ${result.afterRef} (${result.changes.length} commits)\x1b[0m`)
              for (const c of result.changes.slice(0, 5)) console.log(`  \x1b[90m${c}\x1b[0m`)
              if (result.changes.length > 5) console.log(`  \x1b[90m... and ${result.changes.length - 5} more\x1b[0m`)
              console.log('\n\x1b[90mRestarting...\x1b[0m\n')
              // Close databases before restart
              kg.close(); assetStore.close(); taskStore.close(); dataStore.close()
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

  transport.onMessage(async (message, sessionId, images) => {
    abortController = new AbortController()

    // Auto-switch to vision model when images are attached
    let activeProvider = provider
    if (images && images.length > 0) {
      // Map known text-only models to their vision counterparts
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

    try {
      const events = agentLoop(
        {
          provider: activeProvider,
          toolRegistry,
          toolLoader,
          systemPrompt,
          config: { maxTurns: 50, maxCostPerSession: 5 },
          hooks: {},
        },
        message,
        conversationHistory,
        abortController.signal,
        images,
      )

      for await (const event of events) {
        tracer?.processEvent(event)

        // Track session metadata from events
        if (event.type === 'tool_start') {
          sessionToolsUsed.add(event.tool)
          // Track task references
          if (event.tool === 'core:task_create' || event.tool === 'core:task_update') {
            const taskId = (event.args as any)?.id
            if (taskId) sessionTaskIds.add(taskId)
          }
          // Track agent delegation
          if (event.tool === 'core:delegate') {
            const agentId = (event.args as any)?.agent
            if (agentId && agentId !== 'list') sessionAgentsUsed.add(agentId)
          }
        }

        if (event.type === 'messages_updated') {
          conversationHistory = [...event.messages]

          // Update session with tracked metadata
          currentSession = {
            ...currentSession,
            messages: conversationHistory,
            updatedAt: new Date(),
            totalTurns: currentSession.totalTurns + 1,
            totalCost: tracer?.getSessionCost() || currentSession.totalCost,
            toolsUsed: [...sessionToolsUsed],
            agentsUsed: [...sessionAgentsUsed],
            taskIds: [...sessionTaskIds],
          }
          await sessionStore.save(currentSession)
        } else {
          transport.send(event, sessionId)
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

  transport.onCancel((_sessionId) => {
    abortController?.abort()
  })

  // Check if scheduler daemon is running
  const schedulerHealth = HealthManager.isAlive(join(process.env.HOME || '.', '.teya'))
  if (schedulerHealth.alive) {
    const cronTasks = taskStore.listCronTasks()
    if (cronTasks.length > 0) console.log(`\x1b[90mScheduler: ${cronTasks.length} cron tasks (PID ${schedulerHealth.pid})\x1b[0m`)
  } else {
    const cronTasks = taskStore.listCronTasks()
    if (cronTasks.length > 0) {
      console.log(`\x1b[33mScheduler not running — ${cronTasks.length} cron tasks won't execute. Run: teya scheduler start\x1b[0m`)
    }
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
