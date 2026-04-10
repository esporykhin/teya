/**
 * @description Executes scheduled tasks in isolated agent sessions.
 *
 * Each task gets its own: provider instance, tool registry, system prompt.
 * Supports multi-agent dispatch via AgentRegistry.
 */
import { agentLoop, buildSystemPrompt } from '@teya/core'
import type { AgentEvent, LLMProvider } from '@teya/core'
import { openrouter, ollama, withToolAdapter } from '@teya/providers'
import { createToolRegistry, registerBuiltins, initWorkspace, getWorkspaceInfo } from '@teya/tools'
import { AgentRegistry, type AgentDef } from '@teya/orchestrator'
import { KnowledgeGraph, createMemoryTools } from '@teya/memory'
import { randomUUID } from 'crypto'
import type { TaskStore, Task } from './task-store.js'
import { createTaskTools } from './tools.js'
import type { CronEngineExecutor } from './cron-engine.js'

export interface DaemonExecutorConfig {
  provider: string
  model: string
  apiKey: string
}

/** Handler for a built-in task — receives the task and returns a result string */
export type BuiltinHandler = (task: Task, signal: AbortSignal) => Promise<string>

export class DaemonExecutor implements CronEngineExecutor {
  private activeExecutions = new Map<string, Promise<void>>()
  private builtinHandlers = new Map<string, BuiltinHandler>()

  constructor(
    private config: DaemonExecutorConfig,
    private registry: AgentRegistry,
    private store: TaskStore,
    private kg: KnowledgeGraph,
    private onStart?: (task: Task, execId: string) => void,
    private onComplete?: (task: Task, result: string) => void,
    private onError?: (task: Task, error: Error) => void,
  ) {}

  /** Register a handler for a "builtin:<name>" prompt. */
  registerBuiltin(handler: string, fn: BuiltinHandler): void {
    this.builtinHandlers.set(handler, fn)
  }

  async execute(task: Task, signal: AbortSignal): Promise<void> {
    const execId = randomUUID().slice(0, 12)

    this.store.createExecution({
      id: execId,
      taskId: task.id,
      startedAt: new Date().toISOString(),
      status: 'running',
      agentId: task.assignee,
    })

    this.store.update(task.id, { status: 'in_progress' })
    this.onStart?.(task, execId)

    const promise = this.run(task, execId, signal)
    this.activeExecutions.set(task.id, promise)

    try {
      await promise
    } finally {
      this.activeExecutions.delete(task.id)
    }
  }

  async waitForAll(timeoutMs: number): Promise<void> {
    if (this.activeExecutions.size === 0) return
    const deadline = Date.now() + timeoutMs
    const promises = [...this.activeExecutions.values()]
    await Promise.race([
      Promise.allSettled(promises),
      new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
    ])
  }

  private async run(task: Task, execId: string, signal: AbortSignal): Promise<void> {
    let result = ''
    let totalInputTokens = 0
    let totalOutputTokens = 0

    try {
      // 0. Built-in handler shortcut — no LLM session needed
      const builtinKey = task.prompt?.startsWith('builtin:') ? task.prompt : undefined
      if (builtinKey) {
        const handler = this.builtinHandlers.get(builtinKey)
        if (handler) {
          result = await handler(task, signal)
          this.store.updateExecution(execId, {
            status: 'completed',
            finishedAt: new Date().toISOString(),
            result: result.slice(0, 5000),
          })
          if (task.cron) {
            this.store.markRun(task.id, result.slice(0, 2000))
            this.store.update(task.id, { status: 'pending', retryCount: 0 })
          } else {
            this.store.update(task.id, { status: 'completed', result: result.slice(0, 2000) })
          }
          this.onComplete?.(task, result)
          return
        }
        // Unknown builtin — fail fast instead of running as LLM prompt
        throw new Error(`No handler registered for builtin task: ${builtinKey}`)
      }

      // 1. Resolve agent
      const agentDef = task.assignee ? this.registry.get(task.assignee) : undefined

      // 2. Create isolated provider
      const provider = this.createProvider(agentDef)

      // 3. Create isolated tool registry
      const toolRegistry = createToolRegistry()
      registerBuiltins(toolRegistry)

      // Register task tools so the agent can manage tasks from within scheduled execution
      const taskTools = createTaskTools(this.store)
      toolRegistry.register(taskTools.taskCreate)
      toolRegistry.register(taskTools.taskList)
      toolRegistry.register(taskTools.taskUpdate)
      toolRegistry.register(taskTools.taskGet)
      toolRegistry.register(taskTools.schedule)

      // Register memory tools (shared knowledge graph)
      const memTools = createMemoryTools(this.kg)
      toolRegistry.register(memTools.memoryRead)
      toolRegistry.register(memTools.memoryWrite)

      // 4. Build system prompt
      const systemPrompt = await buildSystemPrompt({
        agentDir: agentDef?.dir,
        personality: agentDef?.config.personality,
        instructions: agentDef?.config.instructions,
      }) + '\n\n' + getWorkspaceInfo()
        + `\n\nYou are executing a scheduled task. Task: "${task.title}"\nBe autonomous — complete the task and report the result concisely.`

      // 5. Run agent loop
      const prompt = task.prompt || task.description || task.title
      const gen = agentLoop(
        {
          provider,
          toolRegistry,
          systemPrompt,
          config: { maxTurns: 20, maxCostPerSession: 2 },
          hooks: {},
        },
        prompt,
        [], // empty history — isolated session
        signal,
      )

      for await (const event of gen) {
        if (event.type === 'response') {
          result = event.content
        }
        if (event.type === 'thinking_end') {
          totalInputTokens += event.tokens.inputTokens
          totalOutputTokens += event.tokens.outputTokens
        }
      }

      // 6. Success
      const costUsd = this.estimateCost(totalInputTokens, totalOutputTokens, provider)

      this.store.updateExecution(execId, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
        result: result.slice(0, 5000),
        costUsd,
        tokenUsageInput: totalInputTokens,
        tokenUsageOutput: totalOutputTokens,
      })

      // Cron task: mark run, reset to pending
      if (task.cron) {
        this.store.markRun(task.id, result.slice(0, 2000))
        this.store.update(task.id, { status: 'pending', retryCount: 0 })
      } else {
        this.store.update(task.id, { status: 'completed', result: result.slice(0, 2000) })
      }

      this.onComplete?.(task, result)

    } catch (err) {
      const error = err as Error
      const isTimeout = signal.aborted

      this.store.updateExecution(execId, {
        status: isTimeout ? 'timeout' : 'failed',
        finishedAt: new Date().toISOString(),
        error: error.message,
        tokenUsageInput: totalInputTokens,
        tokenUsageOutput: totalOutputTokens,
      })

      // Retry logic
      if (task.retryCount < task.maxRetries) {
        this.store.update(task.id, { status: 'pending', retryCount: task.retryCount + 1 })
      } else {
        this.store.update(task.id, { status: 'failed', result: `Error: ${error.message}` })
      }

      this.onError?.(task, error)
    }
  }

  private createProvider(agentDef?: AgentDef): LLMProvider {
    const pc = agentDef?.config.provider
    if (pc?.type === 'openrouter') {
      return openrouter({ model: pc.model, apiKey: pc.apiKey || this.config.apiKey })
    }
    if (pc?.type === 'ollama') {
      return withToolAdapter(ollama({ model: pc.model }))
    }
    // Default from global config
    if (this.config.provider === 'ollama') {
      return withToolAdapter(ollama({ model: this.config.model }))
    }
    return openrouter({ model: this.config.model, apiKey: this.config.apiKey })
  }

  private estimateCost(inputTokens: number, outputTokens: number, provider: LLMProvider): number {
    const cap = provider.capabilities
    return inputTokens * cap.costPerInputToken + outputTokens * cap.costPerOutputToken
  }
}
