/**
 * @description Fallback chain — tries providers in order on failure
 * @exports fallback
 */
import type { LLMProvider, GenerateRequest, GenerateOptions, GenerateResponse } from '@teya/core'

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
    capabilities: providers[0].capabilities,

    async generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResponse> {
      let lastError: Error | null = null

      for (let i = 0; i < providers.length; i++) {
        const provider = providers[i]

        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            return await provider.generate(request, options)
          } catch (error) {
            lastError = error as Error

            if (attempt < retries) {
              // Retry same provider
              await new Promise(resolve => setTimeout(resolve, retryDelay))
              continue
            }

            // Move to next provider
            if (i + 1 < providers.length) {
              config.onFallback?.(provider.name, providers[i + 1].name, lastError)
            }
          }
        }
      }

      throw lastError || new Error('All providers failed')
    },
  }
}
