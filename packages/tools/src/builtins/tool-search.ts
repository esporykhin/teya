/**
 * @description core:tool_search — discover available tools by keyword
 */
import type { ToolDefinition } from '@teya/core'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

// This tool needs access to the registry — execute function is set dynamically in registerBuiltins
export const toolSearchTool: RegisteredTool = {
  name: 'core:tool_search',
  description:
    'Search for available tools by keyword. Use this when you need to find the right tool for a task. Returns tool names and descriptions.',
  parameters: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'What kind of tool are you looking for?' },
    },
    required: ['query'],
  },
  source: 'builtin' as const,
  cost: {
    latency: 'instant' as const,
    tokenCost: 'low' as const,
    sideEffects: false,
    reversible: true,
    external: false,
  },
  // Placeholder — real execute is set in registerBuiltins
  execute: async (_args: Record<string, unknown>) => 'Tool search not initialized',
}
