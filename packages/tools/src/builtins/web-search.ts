/**
 * @description core:web_search — search the web via DuckDuckGo
 */
import type { ToolDefinition } from '@teya/core'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

export const webSearchTool: RegisteredTool = {
  name: 'core:web_search',
  description: 'Google-like search. Returns list of links with snippets. Use when you need to FIND something on the internet. After finding links, use core:web_fetch to read the actual page.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
      numResults: {
        type: 'number',
        description: 'Number of results to return',
        default: 5,
      },
    },
    required: ['query'],
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
    const query = args.query as string
    const numResults = (args.numResults as number | undefined) ?? 5

    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TeyaAgent/0.1)' },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const html = await response.text()

    // Parse results from DuckDuckGo HTML
    // Results are in <a class="result__a" href="...">title</a> and <a class="result__snippet">snippet</a>
    const results: string[] = []
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi
    let match
    let count = 0
    while ((match = resultRegex.exec(html)) !== null && count < numResults) {
      const href = match[1]
      const title = match[2].replace(/<[^>]*>/g, '').trim()
      const snippet = match[3].replace(/<[^>]*>/g, '').trim()
      if (title && href) {
        results.push(`${count + 1}. ${title}\n   ${href}\n   ${snippet}`)
        count++
      }
    }

    return results.length > 0 ? results.join('\n\n') : 'No results found.'
  },
}
