/**
 * @description core:ask_user — ask user a question and wait for response
 */
import type { ToolDefinition } from '@teya/core'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

export const askUserTool: RegisteredTool = {
  name: 'core:ask_user',
  description: 'Ask the user a question and wait for their response.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask',
      },
    },
    required: ['question'],
  },
  source: 'builtin',
  cost: {
    latency: 'slow',
    tokenCost: 'none',
    sideEffects: false,
    reversible: true,
    external: false,
  },
  execute: async (args) => {
    return `__ASK_USER__:${args.question as string}`
  },
}
