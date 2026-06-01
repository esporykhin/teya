/**
 * @description Tests for the OpenRouter reasoning-effort mapping.
 *
 * Load-bearing rules under test (asserted on the actual outbound request body,
 * captured via a stubbed fetch):
 *   1. effort: low|medium|high → body.reasoning = { effort: <level> }.
 *   2. NO effort and NO disableReasoning → no `reasoning` field at all.
 *   3. disableReasoning WINS over effort → body.reasoning = { enabled: false }
 *      (skipping thinking must not be silently re-enabled by a per-bot effort).
 * Mutation-checked: break the precedence (effort over disableReasoning) and #3 reds.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { openrouter } from '../src/openrouter.js'

/** A minimal OpenAI-compatible success response. */
function okResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'gen-1',
      model: 'test/model',
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** Stub fetch; return the parsed body of the chat/completions POST. */
async function captureBody(provider: ReturnType<typeof openrouter>): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined
  const stub = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    // The /models refresh also hits fetch — ignore it; only capture the POST.
    if (u.includes('/chat/completions')) {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>
      return okResponse()
    }
    return new Response('[]', { status: 200 })
  })
  vi.stubGlobal('fetch', stub)
  await provider.generate({ messages: [{ role: 'user', content: 'hello' }] })
  if (!captured) throw new Error('chat/completions request was never made')
  return captured
}

afterEach(() => vi.unstubAllGlobals())

describe('openrouter reasoning-effort mapping', () => {
  it('sets body.reasoning = { effort } for each level', async () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      const body = await captureBody(openrouter({ model: 'test/model', apiKey: 'k', effort: level }))
      expect(body.reasoning).toEqual({ effort: level })
    }
  })

  it('omits reasoning entirely when neither effort nor disableReasoning is set', async () => {
    const body = await captureBody(openrouter({ model: 'test/model', apiKey: 'k' }))
    expect('reasoning' in body).toBe(false)
  })

  it('disableReasoning wins over effort (enabled:false, not effort)', async () => {
    const body = await captureBody(
      openrouter({ model: 'test/model', apiKey: 'k', disableReasoning: true, effort: 'high' }),
    )
    expect(body.reasoning).toEqual({ enabled: false })
  })
})
