/**
 * @description Dynamic tool selection — picks relevant tools per message based on context budget
 * @exports DynamicToolLoader, createDynamicToolLoader
 */
import type { ToolDefinition, ProviderCapabilities } from '@teya/core'

const ALWAYS_ON = new Set([
  'core:think',
  'core:plan',
  'core:ask_user',
  'core:tool_search',
  'core:delegate',
  'data:list_tables',
])

export class DynamicToolLoader {
  private allTools: ToolDefinition[] = []
  private recentlyUsed: Set<string> = new Set()

  setTools(tools: ToolDefinition[]): void {
    this.allTools = tools
  }

  markUsed(toolName: string): void {
    this.recentlyUsed.add(toolName)
  }

  resetSession(): void {
    this.recentlyUsed.clear()
  }

  selectTools(
    userMessage: string,
    capabilities: ProviderCapabilities
  ): ToolDefinition[] {
    const budget = this.calculateBudget(capabilities.maxContextTokens)

    // If budget is unlimited or we have few tools — return all
    if (budget >= this.allTools.length) {
      return this.allTools
    }

    const selected: Map<string, ToolDefinition> = new Map()

    // 1. Always-on tools
    for (const tool of this.allTools) {
      if (ALWAYS_ON.has(tool.name)) {
        selected.set(tool.name, tool)
      }
    }

    // 2. Recently used tools (stay in context for continuity)
    for (const tool of this.allTools) {
      if (this.recentlyUsed.has(tool.name) && selected.size < budget) {
        selected.set(tool.name, tool)
      }
    }

    // 3. BM25-like keyword matching on user message
    if (selected.size < budget) {
      const queryWords = new Set(
        userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 2)
      )

      const scored = this.allTools
        .filter(t => !selected.has(t.name))
        .map(t => {
          const text = `${t.name} ${t.description}`.toLowerCase()
          const words = text.split(/\s+/)
          let score = 0
          for (const qw of queryWords) {
            for (const tw of words) {
              if (tw.includes(qw) || qw.includes(tw)) score++
            }
          }
          return { tool: t, score }
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)

      for (const { tool } of scored) {
        if (selected.size >= budget) break
        selected.set(tool.name, tool)
      }
    }

    // 4. If still under budget, fill with remaining tools by source priority (builtin > mcp > plugin > data)
    if (selected.size < budget) {
      const priority: Record<string, number> = { builtin: 0, mcp: 1, plugin: 2, data: 3 }
      const remaining = this.allTools
        .filter(t => !selected.has(t.name))
        .sort((a, b) => (priority[a.source] ?? 9) - (priority[b.source] ?? 9))

      for (const tool of remaining) {
        if (selected.size >= budget) break
        selected.set(tool.name, tool)
      }
    }

    return [...selected.values()]
  }

  private calculateBudget(maxContextTokens: number): number {
    if (maxContextTokens < 16000) return 8       // minimal: 8 tools
    if (maxContextTokens < 65000) return 25      // standard: 25 tools
    return this.allTools.length                   // large: all tools
  }
}

export function createDynamicToolLoader(): DynamicToolLoader {
  return new DynamicToolLoader()
}
