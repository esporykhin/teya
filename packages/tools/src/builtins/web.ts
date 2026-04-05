/**
 * @description core:web — unified web tool (fetch, search, http request).
 *
 * Actions:
 *   fetch   — read a web page as plain text
 *   search  — search the web via DuckDuckGo
 *   request — make an HTTP API request (GET/POST/PUT/DELETE)
 */
import type { ToolDefinition } from '@teya/core'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

export const webTool: RegisteredTool = {
  name: 'core:web',
  description: `Web operations. Actions:
  fetch   — read a web page as plain text (HTML stripped). For articles, docs.
  search  — search the internet (DuckDuckGo). Returns links + snippets.
  request — HTTP API call (GET/POST/PUT/DELETE) with headers and body.`,
  parameters: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['fetch', 'search', 'request'], description: 'Action' },
      url: { type: 'string', description: 'URL (fetch/request)' },
      query: { type: 'string', description: 'Search query (search)' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP method (request). Default: GET' },
      headers: { type: 'object', description: 'HTTP headers as key-value pairs (request)' },
      body: { type: 'string', description: 'Request body (request)' },
      max_length: { type: 'number', description: 'Max chars to return (fetch). Default: 10000' },
      num_results: { type: 'number', description: 'Number of search results (search). Default: 5' },
    },
    required: ['action'],
  },
  source: 'builtin' as const,
  cost: { latency: 'fast' as const, tokenCost: 'low' as const, sideEffects: false, reversible: true, external: true },
  execute: async (args: Record<string, unknown>) => {
    const action = args.action as string

    switch (action) {
      case 'fetch': {
        const url = args.url as string
        if (!url) return 'Need url for fetch.'
        const maxLength = (args.max_length as number) || 10000

        const response = await fetch(url, {
          headers: { 'User-Agent': 'TeyaAgent/1.0 (+https://github.com/teya-agent)' },
        })
        if (!response.ok) return `HTTP ${response.status}: ${response.statusText}`

        const html = await response.text()
        const text = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
        return text.length > maxLength ? text.slice(0, maxLength) + '...' : text
      }

      case 'search': {
        const query = args.query as string
        if (!query) return 'Need query for search.'
        const numResults = (args.num_results as number) || 5

        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TeyaAgent/0.1)' },
        })
        if (!response.ok) return `HTTP ${response.status}: ${response.statusText}`

        const html = await response.text()
        const results: string[] = []
        const regex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi
        let match
        let count = 0
        while ((match = regex.exec(html)) !== null && count < numResults) {
          const href = match[1]
          const title = match[2].replace(/<[^>]*>/g, '').trim()
          const snippet = match[3].replace(/<[^>]*>/g, '').trim()
          if (title && href) {
            results.push(`${count + 1}. ${title}\n   ${href}\n   ${snippet}`)
            count++
          }
        }
        return results.length > 0 ? results.join('\n\n') : 'No results found.'
      }

      case 'request': {
        const url = args.url as string
        if (!url) return 'Need url for request.'
        const method = (args.method as string) || 'GET'
        const headers = (args.headers as Record<string, string>) || {}
        const body = args.body as string | undefined

        const response = await fetch(url, {
          method,
          headers: { 'User-Agent': 'TeyaAgent/1.0', ...headers },
          body: body || undefined,
        })

        const status = `${response.status} ${response.statusText}`
        const text = await response.text()
        return `${status}\n\n${text.slice(0, 10000)}`
      }

      default:
        return `Unknown action: ${action}. Use: fetch, search, request`
    }
  },
}
