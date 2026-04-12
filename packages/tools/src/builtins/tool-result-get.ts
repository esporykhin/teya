/**
 * @description core:tool_result_get — retrieve the full output of a previous
 *  tool call after sliding-window compaction has shrunk it in history.
 *
 * The agent loop's per-turn condenser replaces large tool results in the
 * conversation history with a short summary + retrieval marker, e.g.:
 *
 *   [#call_abc123 core:web — first 200 chars: <html>...]
 *   [Original was 1348 chars. Use core:tool_result_get(id="call_abc123") to retrieve.]
 *
 * If the agent later realises it needs the full content, it calls this
 * tool with the call id. The full content lives in a per-session in-memory
 * store (SessionRuntimeContext.toolResults), accessed via AsyncLocalStorage
 * — there's no global state, no cross-session leakage.
 */
import type { ToolDefinition } from '@teya/core'
import { getCurrentSession } from '@teya/core'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

export const toolResultGetTool: RegisteredTool = {
  name: 'core:tool_result_get',
  description:
    'Retrieve the full content of a previous tool call result after it was truncated in conversation history. You will see truncation markers like [#call_xxx core:web — first 200 chars: ... Use core:tool_result_get(id="call_xxx") to retrieve]. Pass the id from the marker.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Tool call id from a truncation marker (e.g. "call_abc123")',
      },
    },
    required: ['id'],
  },
  source: 'builtin',
  cost: {
    latency: 'instant',
    tokenCost: 'low',
    sideEffects: false,
    reversible: true,
    external: false,
  },
  execute: async (args: Record<string, unknown>) => {
    const id = String(args.id || '').trim()
    if (!id) return 'Error: id is required.'

    const session = getCurrentSession()
    if (!session) {
      return 'Error: no active session context. Tool result store is unavailable in this call path.'
    }

    const entry = session.toolResults.get(id)
    if (!entry) {
      const known = [...session.toolResults.keys()].slice(0, 10).join(', ')
      return `No tool result found with id "${id}". Known recent ids: ${known || '(none)'}`
    }

    entry.retrievedCount++
    const ageSec = Math.round((Date.now() - entry.createdAt) / 1000)
    return [
      `Retrieved full result for #${id} (${entry.toolName})`,
      `Args: ${entry.argsSummary}`,
      `Age: ${ageSec}s, retrieved ${entry.retrievedCount} time(s)`,
      '---',
      entry.fullContent,
    ].join('\n')
  },
}
