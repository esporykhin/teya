/**
 * @description Execute delegated tasks in isolated sub-agent loops
 */
import { agentLoop, buildSystemPrompt } from '@teya/core'
import type { LLMProvider, AgentEvent } from '@teya/core'
import { createToolRegistry, registerBuiltins } from '@teya/tools'
import { openrouter, ollama, withToolAdapter } from '@teya/providers'
import type { AgentTracer } from '@teya/tracing'
import type { AgentDef } from './registry.js'

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

  const systemPrompt = await buildSystemPrompt({
    agentDir: agent.dir,
    personality: agent.config.personality,
    instructions: agent.config.instructions,
  })

  const input = context ? `Context from parent agent:\n${context}\n\nTask:\n${task}` : task

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const gen = agentLoop(
      { provider, toolRegistry, systemPrompt, config: { maxTurns: 20, maxCostPerSession: 2 } },
      input,
      [],
      controller.signal,
    )

    for await (const event of gen) {
      events.push(event)
      if (event.type === 'response') {
        result = event.content
      }
    }

    const delegateResult: DelegateResult = { status: 'completed', result: result || 'Sub-agent completed without response.', events }
    options?.tracer?.processDelegation(agent.id, task, events, 'completed')
    return delegateResult
  } catch (err) {
    const delegateResult: DelegateResult = { status: 'failed', result: `Sub-agent error: ${(err as Error).message}`, events }
    options?.tracer?.processDelegation(agent.id, task, events, 'failed')
    return delegateResult
  } finally {
    clearTimeout(timer)
  }
}
