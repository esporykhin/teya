/**
 * @description Adds tool calling to models without native support via XML tags in prompt
 * @exports withToolAdapter
 */
import type {
  LLMProvider,
  GenerateRequest,
  GenerateOptions,
  GenerateResponse,
  ToolDefinition,
  ToolCall,
} from '@teya/core'

// ─── Prompt formatting ────────────────────────────────────────────────────────

function formatToolsForPrompt(tools: ToolDefinition[]): string {
  let text =
    '## Available Tools\n\n' +
    'When you need to use a tool, wrap your call in XML tags like this:\n' +
    '<tool>{"tool": "tool_name", "args": {"param": "value"}}</tool>\n\n' +
    'You can call multiple tools. When done, respond normally without tool tags.\n\n' +
    'Tools:\n'

  for (const tool of tools) {
    const props = (tool.parameters as { properties?: Record<string, { type: string; description?: string }> })
      ?.properties ?? {}
    const params = Object.entries(props)
      .map(([k, v]) => `${k}: ${v.type}${v.description ? ' — ' + v.description : ''}`)
      .join(', ')
    text += `- ${tool.name}(${params}) — ${tool.description}\n`
  }

  return text
}

// ─── Response parsing ─────────────────────────────────────────────────────────

function parseToolCalls(content: string): { content: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = []
  const regex = /<tool>([\s\S]*?)<\/tool>/g
  let match
  let cleanContent = content

  while ((match = regex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as { tool: string; args?: Record<string, unknown> }
      toolCalls.push({
        id: `call_${toolCalls.length}_${Date.now()}`,
        name: parsed.tool,
        args: parsed.args ?? {},
      })
      cleanContent = cleanContent.replace(match[0], '')
    } catch {
      // skip malformed tags
    }
  }

  return { content: cleanContent.trim(), toolCalls }
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export function withToolAdapter(provider: LLMProvider): LLMProvider {
  // If provider already supports tool calling natively, pass through unchanged
  if (provider.capabilities.toolCalling) return provider

  async function generate(
    request: GenerateRequest,
    options?: GenerateOptions,
  ): Promise<GenerateResponse> {
    const messages = [...request.messages]

    if (request.tools && request.tools.length > 0) {
      const toolText = formatToolsForPrompt(request.tools)

      const sysIdx = messages.findIndex((m) => m.role === 'system')
      if (sysIdx >= 0) {
        messages[sysIdx] = {
          ...messages[sysIdx],
          content: messages[sysIdx].content + '\n\n' + toolText,
        }
      } else {
        messages.unshift({ role: 'system', content: toolText })
      }
    }

    // Call underlying provider without tools (text-based)
    const response = await provider.generate({ ...request, messages, tools: undefined }, options)

    const { content, toolCalls } = parseToolCalls(response.content)

    return {
      ...response,
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : response.toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : response.finishReason,
    }
  }

  return {
    ...provider,
    name: `${provider.name}+tool-adapter`,
    capabilities: { ...provider.capabilities, toolCalling: true },
    generate,
    // stream is intentionally omitted: tool adapter works only with generate()
    // since streaming requires accumulating full response before parsing XML tags
    stream: undefined,
  }
}
