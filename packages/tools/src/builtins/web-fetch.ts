/**
 * @description core:web_fetch — fetch web page as readable text
 */
import type { ToolDefinition } from '@teya/core'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

export const webFetchTool: RegisteredTool = {
  name: 'core:web_fetch',
  description: 'Read a web page as plain text (HTML stripped). For reading articles, docs, blog posts. NOT for APIs — use core:http_request for APIs. NOT for interactive sites — use core:browser_navigate for that.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to fetch',
      },
      maxLength: {
        type: 'number',
        description: 'Max characters to return',
        default: 10000,
      },
    },
    required: ['url'],
  },
  source: 'builtin',
  cost: {
    latency: 'fast',
    tokenCost: 'low',
    sideEffects: false,
    reversible: true,
    external: true,
  },
  execute: async (args) => {
    const url = args.url as string
    const maxLength = (args.maxLength as number | undefined) ?? 10000

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'TeyaAgent/1.0 (+https://github.com/teya-agent)',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const html = await response.text()
    const text = html
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text
  },
}
