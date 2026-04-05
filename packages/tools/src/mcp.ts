/**
 * @description MCP client — connects to MCP servers, registers their tools
 * @exports MCPManager, createMCPManager
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
// SSE transport: import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { ToolRegistry } from './registry.js'

interface MCPServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface MCPConnection {
  client: Client
  transport: StdioClientTransport
  serverName: string
}

export class MCPManager {
  private connections: MCPConnection[] = []

  async connectServer(config: MCPServerConfig, registry: ToolRegistry): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
    })

    const client = new Client({ name: 'teya-agent', version: '0.1.0' }, { capabilities: {} })
    await client.connect(transport)

    const serverName = config.command.split('/').pop() || config.command

    // List tools from MCP server
    const { tools } = await client.listTools()

    for (const tool of tools) {
      const toolName = `mcp:${serverName}:${tool.name}`

      registry.register({
        name: toolName,
        description: tool.description || `MCP tool: ${tool.name}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        source: 'mcp',
        tags: ['mcp', serverName],
        cost: {
          latency: 'fast',
          tokenCost: 'low',
          sideEffects: true, // conservative default
          reversible: false,
          external: false,
        },
        execute: async (args: Record<string, unknown>) => {
          const result = await client.callTool({ name: tool.name, arguments: args })
          // result.content is an array of content blocks
          if (Array.isArray(result.content)) {
            return result.content
              .map((block: unknown) => {
                const b = block as Record<string, unknown>
                if (b.type === 'text') return b.text as string
                if (b.type === 'image') return `[Image: ${b.mimeType}]`
                return JSON.stringify(b)
              })
              .join('\n')
          }
          return String(result.content)
        },
      })
    }

    this.connections.push({ client, transport, serverName })
    console.log(`[MCP] Connected to ${serverName}: ${tools.length} tools registered`)
  }

  async disconnectAll(): Promise<void> {
    for (const conn of this.connections) {
      try {
        await conn.client.close()
      } catch { /* ignore */ }
    }
    this.connections = []
  }
}

export function createMCPManager(): MCPManager {
  return new MCPManager()
}
