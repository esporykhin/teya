/**
 * @description Tool registry — register, lookup, execute tools
 * @exports ToolRegistry, createToolRegistry
 */
import type { ToolDefinition, ToolCall, ToolResult } from '@teya/core'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map()

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(({ execute: _execute, ...def }) => def)
  }

  listNames(): string[] {
    return Array.from(this.tools.keys())
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.get(call.name)
    if (!tool) {
      return {
        callId: call.id,
        result: `Error: Tool "${call.name}" not found. Available: ${this.listNames().join(', ')}`,
        error: true,
      }
    }

    // Validate required args are present
    const required = (tool.parameters as any)?.required as string[] | undefined
    if (required && required.length > 0) {
      const missing = required.filter(key => call.args[key] === undefined || call.args[key] === null)
      if (missing.length > 0) {
        const hasRaw = '_raw' in call.args
        return {
          callId: call.id,
          result: `Error: Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')} for tool ${call.name}.${hasRaw ? ' (Arguments could not be parsed from model output — try shorter content or split into multiple calls.)' : ''}`,
          error: true,
        }
      }
    }

    try {
      const result = await tool.execute(call.args)
      return { callId: call.id, result }
    } catch (err) {
      return {
        callId: call.id,
        result: `Error executing ${call.name}: ${(err as Error).message}`,
        error: true,
      }
    }
  }
}

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry()
}
