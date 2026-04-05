/**
 * @description core:think — scratchpad for reasoning, no side effects
 */
import type { ToolDefinition } from '@teya/core'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

export const thinkTool: RegisteredTool = {
  name: 'core:think',
  description: 'Private scratchpad — reason through a problem before acting. User does NOT see this. Use when you need to analyze, compare options, or plan internally.',
  parameters: {
    type: 'object',
    properties: {
      thought: {
        type: 'string',
        description: 'Your reasoning',
      },
    },
    required: ['thought'],
  },
  source: 'builtin',
  cost: {
    latency: 'instant',
    tokenCost: 'none',
    sideEffects: false,
    reversible: true,
    external: false,
  },
  execute: async (args) => {
    return args.thought as string
  },
}
