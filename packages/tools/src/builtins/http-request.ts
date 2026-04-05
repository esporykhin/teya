/**
 * @description core:http_request — full HTTP client (any method, headers, body)
 */
import type { ToolDefinition } from '@teya/core'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

export const httpRequestTool: RegisteredTool = {
  name: 'core:http_request',
  description:
    'Call APIs and web services. Returns raw response (JSON, XML, etc). Use for: REST APIs, webhooks, any HTTP endpoint. Supports all methods (GET/POST/PUT/DELETE), headers, body. NOT for reading web pages — use core:web_fetch for that.',
  parameters: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'URL to request' },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
        description: 'HTTP method',
        default: 'GET',
      },
      headers: { type: 'object', description: 'Request headers as key-value pairs' },
      body: {
        type: 'string',
        description: 'Request body (for POST/PUT/PATCH). JSON string or plain text.',
      },
      timeout: { type: 'number', description: 'Timeout in ms. Default 30000.' },
    },
    required: ['url'],
  },
  source: 'builtin' as const,
  cost: {
    latency: 'fast' as const,
    tokenCost: 'low' as const,
    sideEffects: true,
    reversible: false,
    external: true,
  },
  execute: async (args: Record<string, unknown>) => {
    const url = args.url as string
    const method = (args.method as string) || 'GET'
    const headers = (args.headers as Record<string, string>) || {}
    const body = args.body as string | undefined
    const timeout = (args.timeout as number) || 30000

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        method,
        headers: {
          'User-Agent': 'Teya/0.1',
          ...headers,
        },
        body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
        signal: controller.signal,
      })

      clearTimeout(timer)

      const status = response.status
      const statusText = response.statusText

      const contentType = response.headers.get('content-type') || ''
      let responseBody: string

      if (contentType.includes('application/json')) {
        const json = await response.json()
        responseBody = JSON.stringify(json, null, 2)
      } else {
        responseBody = await response.text()
      }

      if (responseBody.length > 10000) {
        responseBody = responseBody.slice(0, 10000) + '\n[...truncated]'
      }

      return `HTTP ${status} ${statusText}\n\n${responseBody}`
    } catch (err: unknown) {
      const error = err as Error
      if (error.name === 'AbortError') return `Error: Request timed out after ${timeout}ms`
      return `Error: ${error.message}`
    }
  },
}
