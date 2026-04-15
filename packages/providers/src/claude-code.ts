/**
 * @description Claude Code CLI provider — wraps Anthropic Claude Code CLI as a black-box agent
 * @exports claudeCode
 */
import { spawn } from 'child_process'
import type {
  LLMProvider,
  GenerateRequest,
  GenerateOptions,
  GenerateResponse,
  ProviderCapabilities,
  Message,
} from '@teya/core'

// ─── Claude Code JSON output types ───────────────────────────────────────────
// `claude -p --output-format json` returns a single JSON object after the turn
// finishes. Shape (stable fields used here):
//   {
//     type: "result",
//     subtype: "success" | "error_during_execution" | ...,
//     result: "final assistant text",
//     session_id: "...",
//     usage: { input_tokens, output_tokens, cache_read_input_tokens?, ... },
//     total_cost_usd: number,
//     is_error: boolean,
//   }

interface ClaudeCodeResult {
  type: 'result'
  subtype: string
  result?: string
  session_id?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  total_cost_usd?: number
  is_error?: boolean
  error?: string
}

// ─── Conversation serializer ─────────────────────────────────────────────────

function buildPromptWithContext(messages: Message[]): string {
  const userMessages = messages.filter((m) => m.role === 'user')
  if (userMessages.length <= 1) {
    return userMessages[0]?.content ?? ''
  }

  const relevant = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-40)

  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
  const history = relevant.slice(0, -1)

  if (history.length === 0) {
    return lastUserMsg?.content ?? ''
  }

  const contextLines = history.map((m) => {
    const role = m.role === 'user' ? 'User' : 'Assistant'
    const content = m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content
    return `${role}: ${content}`
  })

  return `<conversation_context>
${contextLines.join('\n')}
</conversation_context>

User: ${lastUserMsg?.content ?? ''}`
}

// ─── Provider factory ────────────────────────────────────────────────────────

export function claudeCode(config: {
  model?: string
  cwd?: string
  binary?: string
  /** `bypassPermissions` runs fully unattended (equivalent to --dangerously-skip-permissions). */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  /** Shortcut: if true, passes --dangerously-skip-permissions. Default: true. */
  dangerouslySkipPermissions?: boolean
}): LLMProvider {
  const binary = config.binary ?? 'claude'
  const model = config.model ?? undefined // use claude default
  const cwd = config.cwd ?? process.cwd()
  const permissionMode = config.permissionMode
  const skipPermissions = config.dangerouslySkipPermissions ?? true

  const capabilities: ProviderCapabilities = {
    toolCalling: false, // claude code executes tools internally
    parallelToolCalls: false,
    streaming: false,
    vision: false,
    jsonMode: false,
    maxContextTokens: 200_000,
    maxOutputTokens: 16_384,
    costPerInputToken: 0, // tracked by claude itself
    costPerOutputToken: 0,
  }

  async function generate(
    request: GenerateRequest,
    options?: GenerateOptions,
  ): Promise<GenerateResponse> {
    const prompt = buildPromptWithContext(request.messages)

    if (!prompt) {
      return {
        content: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: model ?? 'claude-code-default',
        finishReason: 'stop',
      }
    }

    const args: string[] = ['-p', '--output-format', 'json']

    if (model) args.push('--model', model)
    if (request.systemPrompt) {
      args.push('--append-system-prompt', request.systemPrompt)
    }
    args.push('--add-dir', cwd)

    if (skipPermissions) {
      args.push('--dangerously-skip-permissions')
    } else if (permissionMode && permissionMode !== 'default') {
      args.push('--permission-mode', permissionMode)
    }

    const result = await runClaudeProcess(binary, args, prompt, cwd, options?.signal)

    let parsed: ClaudeCodeResult | undefined
    try {
      parsed = JSON.parse(result.stdout.trim()) as ClaudeCodeResult
    } catch {
      // fall through — treat raw stdout as content
    }

    if (!parsed) {
      const content = result.stdout.trim() || result.stderr.trim()
      return {
        content,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: model ?? 'claude-code-default',
        finishReason: result.exitCode === 0 ? 'stop' : 'error',
      }
    }

    const content = parsed.result ?? parsed.error ?? ''
    const inputTokens = parsed.usage?.input_tokens ?? 0
    const outputTokens = parsed.usage?.output_tokens ?? 0
    const isError = parsed.is_error === true || parsed.subtype !== 'success'

    return {
      content,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      model: model ?? 'claude-code-default',
      finishReason: isError && !content ? 'error' : 'stop',
    }
  }

  return {
    name: `claude-code${model ? ':' + model : ''}`,
    type: 'claude-code',
    capabilities,
    generate,
  }
}

// ─── Process runner ──────────────────────────────────────────────────────────

function runClaudeProcess(
  binary: string,
  args: string[],
  stdin: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.stdin.write(stdin)
    proc.stdin.end()

    proc.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })

    proc.on('error', (err: Error) => {
      reject(new Error(`Claude Code process error: ${err.message}`))
    })

    if (signal) {
      const onAbort = () => {
        proc.kill('SIGTERM')
        reject(new Error('Claude Code: aborted'))
      }
      if (signal.aborted) {
        proc.kill('SIGTERM')
        reject(new Error('Claude Code: aborted'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      proc.on('close', () => signal.removeEventListener('abort', onAbort))
    }
  })
}
