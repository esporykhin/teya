/**
 * @description Fallback chain — tries providers in order on failure
 * @exports fallback
 */
import type { LLMProvider, GenerateRequest, GenerateOptions, GenerateResponse, GenerationDetails } from '@teya/core'

interface FallbackConfig {
  retries?: number      // per provider, default 1
  retryDelay?: number   // ms, default 1000
  onFallback?: (from: string, to: string, error: Error) => void
}

export function fallback(providers: LLMProvider[], config: FallbackConfig = {}): LLMProvider {
  if (providers.length === 0) throw new Error('fallback() requires at least one provider')

  const retries = config.retries ?? 1
  const retryDelay = config.retryDelay ?? 1000

  return {
    name: `fallback(${providers.map(p => p.name).join(', ')})`,
    type: 'fallback',
    capabilities: providers[0].capabilities,

    async generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResponse> {
      let lastError: Error | null = null

      for (let i = 0; i < providers.length; i++) {
        const provider = providers[i]

        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const result = await provider.generate(request, options)
            // Tag which underlying provider actually handled the request — vital
            // for tracing and cost attribution when fallbacks fire.
            return {
              ...result,
              providerMetadata: {
                ...(result.providerMetadata || {}),
                fallbackHandler: provider.name,
                fallbackType: provider.type,
              },
            }
          } catch (error) {
            lastError = error as Error

            if (attempt < retries) {
              await new Promise(resolve => setTimeout(resolve, retryDelay))
              continue
            }

            if (i + 1 < providers.length) {
              config.onFallback?.(provider.name, providers[i + 1].name, lastError)
            }
          }
        }
      }

      throw lastError || new Error('All providers failed')
    },

    // Try each underlying provider that supports lookup until one resolves.
    async getGenerationDetails(generationId: string): Promise<GenerationDetails | null> {
      for (const p of providers) {
        if (!p.getGenerationDetails) continue
        try {
          const d = await p.getGenerationDetails(generationId)
          if (d) return d
        } catch {
          // try next
        }
      }
      return null
    },
  }
}
