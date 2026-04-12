/**
 * @description core:tool_load — promote stub-tier tools to full schema
 *  for the rest of the current session.
 *
 * The catalog the agent sees is tiered:
 *   - Always-on tools (think, plan, respond, memory, etc) — always full
 *   - Activated tools — promoted via this builtin or by use
 *   - Stub tools — name + 1-line description, no parameter spec
 *
 * When the agent sees a stub like "core:exec — run shell commands [STUB]"
 * and decides it needs that tool, it calls:
 *
 *   core:tool_load(["core:exec", "core:browser_navigate"])
 *
 * Then on the NEXT LLM call those tools come with full schemas. They stay
 * activated for the rest of the session.
 */
import type { ToolDefinition } from '@teya/core'
import type { DynamicToolLoader } from '../dynamic-loader.js'
import type { ToolRegistry } from '../registry.js'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

/**
 * Factory — needs the toolLoader (to mark tools activated) and the registry
 * (to fetch full schemas for the response payload). Returns a tool that the
 * caller can register in the same registry.
 */
export function createToolLoadTool(
  toolLoader: DynamicToolLoader,
  toolRegistry: ToolRegistry,
): RegisteredTool {
  return {
    name: 'core:tool_load',
    description:
      'Activate full schemas for tools that are currently shown to you as stubs. Pass an array of tool names. After loading, those tools come with full parameter spec on every subsequent LLM call in this session, so you can call them normally. Use this when you see "[STUB — call core:tool_load(...) for full schema]" next to a tool you need.',
    parameters: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool names to activate, e.g. ["core:exec", "core:browser_navigate"]',
        },
      },
      required: ['names'],
    },
    source: 'builtin',
    cost: {
      latency: 'instant',
      tokenCost: 'none',
      sideEffects: false,
      reversible: true,
      external: false,
    },
    execute: async (args: Record<string, unknown>) => {
      const names = (args.names as string[]) || []
      if (!Array.isArray(names) || names.length === 0) {
        return 'Error: names must be a non-empty array of tool names.'
      }
      const { activated, unknown } = toolLoader.activate(names)
      const lines: string[] = []
      if (activated.length > 0) {
        lines.push(`Activated ${activated.length} tool(s) for the rest of this session:`)
        for (const name of activated) {
          const tool = toolRegistry.get(name)
          if (!tool) continue
          // Show a compact one-liner of params so the model knows what to expect
          // BEFORE the next LLM call (which will carry the full schema).
          const props = (tool.parameters as { properties?: Record<string, { type?: string; description?: string }> })?.properties || {}
          const required = (tool.parameters as { required?: string[] })?.required || []
          const paramList = Object.entries(props)
            .map(([k, v]) => `${k}${required.includes(k) ? '' : '?'}: ${v.type || 'any'}`)
            .join(', ')
          lines.push(`  - ${name}(${paramList})`)
        }
      }
      if (unknown.length > 0) {
        lines.push('')
        lines.push(`Unknown tool name(s) (not found in catalog): ${unknown.join(', ')}`)
      }
      return lines.join('\n') || 'No tools activated.'
    },
  }
}
