/**
 * @description Multi-model routing — different models for thinking, planning, condensing
 * @exports router
 */
import type { LLMProvider, GenerateRequest, GenerateOptions, GenerateResponse } from '@teya/core'

type Phase = 'default' | 'planning' | 'condensing'

interface RouterConfig {
  default: LLMProvider
  planning?: LLMProvider
  condensing?: LLMProvider
}

export function router(config: RouterConfig): LLMProvider & { setPhase(phase: Phase): void } {
  let currentPhase: Phase = 'default'

  function getProvider(): LLMProvider {
    if (currentPhase === 'planning' && config.planning) return config.planning
    if (currentPhase === 'condensing' && config.condensing) return config.condensing
    return config.default
  }

  return {
    name: 'router',
    get capabilities() { return getProvider().capabilities },

    async generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResponse> {
      return getProvider().generate(request, options)
    },

    async *stream(request: GenerateRequest, options?: GenerateOptions) {
      const provider = getProvider()
      if (provider.stream) {
        yield* provider.stream(request, options)
      }
    },

    setPhase(phase: Phase) { currentPhase = phase },
  }
}
