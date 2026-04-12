/**
 * @description Execute delegated tasks in isolated sub-agent loops
 */
import { agentLoop, buildSystemPrompt } from '@teya/core'
import type { LLMProvider, AgentEvent } from '@teya/core'
import { createToolRegistry, registerBuiltins } from '@teya/tools'
import { openrouter, ollama, withToolAdapter } from '@teya/providers'
import { DataStore, createDataTools } from '@teya/data'
import type { AgentTracer } from '@teya/tracing'
import type { AgentDef } from './registry.js'
import { join } from 'path'

export interface DelegateOptions {
  tracer?: AgentTracer
}

export interface DelegateResult {
  status: 'completed' | 'failed' | 'timeout'
  result: string
  events: AgentEvent[]
}

export async function delegateTask(
  agent: AgentDef,
  task: string,
  context?: string,
  parentProvider?: LLMProvider,
  timeout: number = 120000,
  options?: DelegateOptions,
): Promise<DelegateResult> {
  const events: AgentEvent[] = []
  let result = ''

  let provider: LLMProvider
  if (agent.config.provider) {
    const pc = agent.config.provider
    if (pc.type === 'openrouter') {
      provider = openrouter({ model: pc.model, apiKey: pc.apiKey || '' })
    } else if (pc.type === 'ollama') {
      provider = withToolAdapter(ollama({ model: pc.model }))
    } else if (parentProvider) {
      provider = parentProvider
    } else {
      return { status: 'failed', result: 'No provider configured for sub-agent', events: [] }
    }
  } else if (parentProvider) {
    provider = parentProvider
  } else {
    return { status: 'failed', result: 'No provider available for sub-agent', events: [] }
  }

  const toolRegistry = createToolRegistry()
  registerBuiltins(toolRegistry)

  // Register namespaced core:data — sub-agent sees only its own tables + granted
  const dataDbPath = join(process.env.HOME || '.', '.teya', 'data.db')
  const dataStore = new DataStore(dataDbPath, agent.id)
  const dataTools = createDataTools(dataStore)
  toolRegistry.register(dataTools.dataTool)

  const systemPrompt = await buildSystemPrompt({
    agentDir: agent.dir,
    personality: agent.config.personality,
    instructions: agent.config.instructions,
  })

  const input = context ? `Context from parent agent:\n${context}\n\nTask:\n${task}` : task

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  // Open a delegate.X parent span and spawn a child tracer that nests
  // sub-agent spans under it. This gives a real-time hierarchy
  // (parent → delegate → sub-agent.turn → llm.generate / tool.X) instead of
  // the older post-hoc reconstruction. Spans are still routed through the
  // parent's exporter so they end up in the same per-session jsonl file.
  const parentTracer = options?.tracer
  const delegateSpan = parentTracer?.beginDelegateSpan(agent.id, task)
  const childTracer = parentTracer && delegateSpan
    ? parentTracer.spawnChild(delegateSpan.spanId, { agentId: agent.id })
    : undefined

  let subCost = 0
  let subTurns = 0

  try {
    const gen = agentLoop(
      { provider, toolRegistry, systemPrompt, config: { maxTurns: 20, maxCostPerSession: 2 } },
      input,
      [],
      controller.signal,
    )

    for await (const event of gen) {
      events.push(event)
      childTracer?.processEvent(event)
      if (event.type === 'response') {
        result = event.content
        subTurns++
      }
    }
    subCost = childTracer?.getSessionCost() || 0

    const delegateResult: DelegateResult = { status: 'completed', result: result || 'Sub-agent completed without response.', events }
    if (parentTracer && delegateSpan) {
      parentTracer.finishDelegateSpan(delegateSpan, 'completed', { turns: subTurns, cost: subCost })
    }
    return delegateResult
  } catch (err) {
    subCost = childTracer?.getSessionCost() || 0
    const delegateResult: DelegateResult = { status: 'failed', result: `Sub-agent error: ${(err as Error).message}`, events }
    if (parentTracer && delegateSpan) {
      parentTracer.finishDelegateSpan(delegateSpan, 'failed', { turns: subTurns, cost: subCost })
    }
    return delegateResult
  } finally {
    clearTimeout(timer)
    dataStore.close()
  }
}
