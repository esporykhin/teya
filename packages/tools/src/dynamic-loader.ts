/**
 * @description Tier-based tool catalog selection.
 *
 * Three tiers, all selected on every request:
 *
 *   Tier 1 — Always full schema (~6 tools, ~1200 tokens)
 *     Discovery + activation primitives. Without these the LLM can't even
 *     load the rest, so they MUST stay full at all times.
 *
 *   Tier 2 — Activated this session (full schema)
 *     Tools the LLM has explicitly loaded via core:tool_load(), or has
 *     already used in this session (auto-promoted via markUsed()).
 *
 *   Tier 3 — Stubs (~25 tokens each)
 *     Every other tool, exposed only as `name + 1-line description` so the
 *     model knows the tool exists and can decide to load its full schema.
 *     Stubs use a placeholder parameters schema and a description that
 *     ends with "Call core:tool_load(['name']) for full parameters."
 *
 * Token math (typical):
 *   Before:  30 tools × 150 tokens = 4500 tokens per LLM call
 *   After:   6 always × 200 + 5 activated × 200 + 19 stubs × 25
 *          = 1200 + 1000 + 475 = ~2675 tokens per LLM call
 *   Savings: ~1825 tokens per call → ~36k saved across a 20-call turn
 */
import type { ToolDefinition, ProviderCapabilities } from '@teya/core'

/**
 * Tools that ALWAYS get full schema, regardless of usage. These are the
 * cognition + activation primitives — without them the agent has no way
 * to discover or load other tools.
 */
const ALWAYS_FULL = new Set([
  'core:think',
  'core:plan',
  'core:respond',
  'core:ask_user',
  'core:intermediate_response',
  'core:tool_search',
  'core:tool_load',          // tier-2 activation primitive
  'core:tool_result_get',    // sliding-window retrieval primitive
  'core:memory',             // per-scope KG, frequently used
  'core:delegate',           // sub-agent delegation
])

const STUB_PARAMS = {
  type: 'object',
  additionalProperties: true,
  description: 'Schema is hidden in stub mode. Call core:tool_load(["this-tool"]) to load full parameter spec for this session.',
} as const

export class DynamicToolLoader {
  private allTools: ToolDefinition[] = []
  /** Tools the agent has already used or explicitly loaded — get full schema. */
  private activated: Set<string> = new Set()

  setTools(tools: ToolDefinition[]): void {
    this.allTools = tools
  }

  /** Promote a tool to "activated" tier — full schema on next request. */
  markUsed(toolName: string): void {
    this.activated.add(toolName)
  }

  /** Bulk promotion — used by core:tool_load builtin. */
  activate(names: string[]): { activated: string[]; unknown: string[] } {
    const activated: string[] = []
    const unknown: string[] = []
    for (const name of names) {
      if (this.allTools.some(t => t.name === name)) {
        this.activated.add(name)
        activated.push(name)
      } else {
        unknown.push(name)
      }
    }
    return { activated, unknown }
  }

  resetSession(): void {
    this.activated.clear()
  }

  /** Names of tools currently in the activated (full-schema) tier. */
  listActivated(): string[] {
    return [...this.activated]
  }

  /**
   * Build the tools array for one LLM request.
   * Returns ToolDefinition[] where stub-tier tools have been REPLACED with
   * lightweight clones (short description, placeholder parameters), so the
   * caller can pass the result straight to provider.generate({ tools }).
   */
  selectTools(
    _userMessage: string,
    _capabilities: ProviderCapabilities,
  ): ToolDefinition[] {
    return this.allTools.map(tool => {
      const isFull = ALWAYS_FULL.has(tool.name) || this.activated.has(tool.name)
      if (isFull) return tool
      return this.toStub(tool)
    })
  }

  /** Same as selectTools but returns metadata about each tool's mode. */
  selectToolsWithMode(
    userMessage: string,
    capabilities: ProviderCapabilities,
  ): Array<{ tool: ToolDefinition; mode: 'full' | 'stub' }> {
    return this.allTools.map(tool => {
      const isFull = ALWAYS_FULL.has(tool.name) || this.activated.has(tool.name)
      return { tool: isFull ? tool : this.toStub(tool), mode: isFull ? 'full' : 'stub' }
    })
  }

  private toStub(tool: ToolDefinition): ToolDefinition {
    const oneLine = (tool.description || '').split('\n')[0].slice(0, 120)
    return {
      ...tool,
      description: `${oneLine} [STUB — call core:tool_load(["${tool.name}"]) for full schema]`,
      parameters: { ...STUB_PARAMS } as Record<string, unknown>,
    }
  }
}

export function createDynamicToolLoader(): DynamicToolLoader {
  return new DynamicToolLoader()
}
