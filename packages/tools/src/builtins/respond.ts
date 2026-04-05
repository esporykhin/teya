/**
 * @description core:respond — send intermediate response to user without ending the agent loop
 */
export const respondTool = {
  name: 'core:respond',
  description: 'Send an intermediate message to the user without stopping your work. Use this to provide progress updates, partial results, or status messages while continuing to execute further steps.',
  parameters: {
    type: 'object' as const,
    properties: {
      message: { type: 'string', description: 'Message to show the user right now' },
    },
    required: ['message'],
  },
  source: 'builtin' as const,
  cost: { latency: 'instant' as const, tokenCost: 'none' as const, sideEffects: false, reversible: true, external: false },
  execute: async (args: Record<string, unknown>) => {
    return `__RESPOND__:${args.message as string}`
  },
}
