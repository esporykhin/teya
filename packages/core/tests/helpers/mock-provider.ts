import type { LLMProvider, GenerateRequest, GenerateOptions, GenerateResponse, ProviderCapabilities } from '../../src/types.js'

interface MockResponse {
  content: string
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
}

export function createMockProvider(responses: MockResponse[]): LLMProvider {
  let callIndex = 0

  return {
    name: 'mock',
    capabilities: {
      toolCalling: true,
      parallelToolCalls: false,
      streaming: false,
      vision: false,
      jsonMode: false,
      maxContextTokens: 128000,
      maxOutputTokens: 4096,
      costPerInputToken: 0,
      costPerOutputToken: 0,
    } as ProviderCapabilities,

    async generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResponse> {
      if (options?.signal?.aborted) throw new Error('Aborted')

      const response = responses[callIndex] || responses[responses.length - 1]
      callIndex++

      return {
        content: response.content,
        toolCalls: response.toolCalls,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        model: 'mock-model',
        finishReason: response.toolCalls?.length ? 'tool_calls' : 'stop',
      }
    },
  }
}
