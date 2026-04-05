/**
 * @description core:plan — create execution plan for user approval
 */
import type { ToolDefinition } from '@teya/core'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

export const planTool: RegisteredTool = {
  name: 'core:plan',
  description:
    'Show the user your plan before executing a complex task (3+ steps). User sees this and can approve. Use core:think for private reasoning.',
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'What this step does' },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tools needed',
            },
          },
          required: ['description'],
        },
        description: 'Steps of the plan',
      },
      reasoning: { type: 'string', description: 'Why this approach' },
    },
    required: ['steps'],
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
    // Return special marker for agent loop to intercept
    return `__PLAN__:${JSON.stringify(args)}`
  },
}
