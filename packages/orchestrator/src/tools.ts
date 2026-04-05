/**
 * @description core:delegate — delegates tasks to sub-agents
 */
import type { AgentRegistry } from './registry.js'
import type { LLMProvider } from '@teya/core'
import type { AgentTracer } from '@teya/tracing'
import { delegateTask } from './delegator.js'

export function createDelegateTool(registry: AgentRegistry, parentProvider: LLMProvider, tracer?: AgentTracer) {
  return {
    name: 'core:delegate',
    description: 'Delegate a task to a sub-agent. Use data:list_tables pattern — first check available agents, then delegate.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent ID to delegate to. Use "list" to see available agents.' },
        task: { type: 'string', description: 'Task description for the sub-agent.' },
        context: { type: 'string', description: 'Optional context from current conversation to pass.' },
      },
      required: ['agent', 'task'],
    },
    source: 'builtin' as const,
    cost: { latency: 'slow' as const, tokenCost: 'high' as const, sideEffects: true, reversible: false, external: false },
    execute: async (args: Record<string, unknown>) => {
      const agentId = args.agent as string
      const task = args.task as string
      const context = args.context as string | undefined

      if (agentId === 'list') {
        const agents = registry.list()
        if (agents.length === 0) return 'No sub-agents configured. Create agents in ~/.teya/agents/'
        return agents.map(a => `- ${a.id}: ${a.description}`).join('\n')
      }

      const agent = registry.get(agentId)
      if (!agent) {
        const similar = registry.search(agentId)
        if (similar.length > 0) {
          return `Agent "${agentId}" not found. Did you mean: ${similar.map(a => a.id).join(', ')}?`
        }
        return `Agent "${agentId}" not found. Available: ${registry.list().map(a => a.id).join(', ') || 'none'}`
      }

      const result = await delegateTask(agent, task, context, parentProvider, 120000, { tracer })

      if (result.status === 'completed') {
        return result.result
      } else {
        return `Delegation ${result.status}: ${result.result}`
      }
    },
  }
}
