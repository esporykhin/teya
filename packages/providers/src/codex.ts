/**
 * @description Codex CLI provider — wraps OpenAI Codex CLI as a black-box agent
 * @exports codex
 */
import { spawn } from 'child_process'
import { writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  LLMProvider,
  GenerateRequest,
  GenerateOptions,
  GenerateResponse,
  ProviderCapabilities,
  Message,
} from '@teya/core'

// ─── Codex JSONL event types ─────────────────────────────────────────────────

interface CodexThreadStarted {
  type: 'thread.started'
  thread_id: string
}

interface CodexTurnStarted {
  type: 'turn.started'
}

interface CodexItemCompleted {
  type: 'item.completed'
  item: {
    id: string
    type: 'agent_message' | 'file_change' | 'shell_command' | 'error'
    text?: string
    message?: string
    changes?: Array<{ path: string; kind: string }>
    status?: string
  }
}

interface CodexTurnCompleted {
  type: 'turn.completed'
  usage?: {
    input_tokens: number
    cached_input_tokens?: number
    output_tokens: number
  }
}

interface CodexTurnFailed {
  type: 'turn.failed'
  error: { message: string }
}

interface CodexError {
  type: 'error'
  message: string
}

type CodexEvent =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexItemCompleted
  | CodexTurnCompleted
  | CodexTurnFailed
  | CodexError

// ─── Conversation serializer ─────────────────────────────────────────────────

function buildPromptWithContext(messages: Message[]): string {
  // If only one user message — no context needed
  const userMessages = messages.filter((m) => m.role === 'user')
  if (userMessages.length <= 1) {
    return userMessages[0]?.content ?? ''
  }

  // Serialize conversation history (skip system messages, keep last ~20 turns)
  const relevant = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-40) // last 20 exchanges max

  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
  const history = relevant.slice(0, -1) // everything except the last message

  if (history.length === 0) {
    return lastUserMsg?.content ?? ''
  }

  const contextLines = history.map((m) => {
    const role = m.role === 'user' ? 'User' : 'Assistant'
    // Truncate long messages in history to save tokens
    const content = m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content
    return `${role}: ${content}`
  })

  return `<conversation_context>
${contextLines.join('\n')}
</conversation_context>

User: ${lastUserMsg?.content ?? ''}`
}

// ─── Provider factory ────────────────────────────────────────────────────────

export function codex(config: {
  model?: string
  cwd?: string
  binary?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  fullAuto?: boolean
}): LLMProvider {
  const binary = config.binary ?? 'codex'
  const model = config.model ?? undefined // use codex default
  const cwd = config.cwd ?? process.cwd()
  const sandbox = config.sandbox ?? 'workspace-write'
  const fullAuto = config.fullAuto ?? true

  const capabilities: ProviderCapabilities = {
    toolCalling: false, // codex executes tools internally
    parallelToolCalls: false,
    streaming: false,
    vision: false,
    jsonMode: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 16_384,
    costPerInputToken: 0, // tracked by codex itself
    costPerOutputToken: 0,
  }

  async function generate(
    request: GenerateRequest,
    options?: GenerateOptions,
  ): Promise<GenerateResponse> {
    // Build prompt with conversation context
    const prompt = buildPromptWithContext(request.messages)

    if (!prompt) {
      return {
        content: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: model ?? 'codex-default',
        finishReason: 'stop',
      }
    }

    // Write system prompt to temp file if provided
    let instructionsFile: string | undefined
    if (request.systemPrompt) {
      instructionsFile = join(tmpdir(), `teya-codex-instructions-${Date.now()}.md`)
      await writeFile(instructionsFile, request.systemPrompt, 'utf-8')
    }

    // Build args
    const args: string[] = ['exec', '--json', '--skip-git-repo-check']

    if (sandbox === 'danger-full-access') {
      args.push('--dangerously-bypass-approvals-and-sandbox')
    } else if (fullAuto) {
      args.push('--full-auto')
    } else {
      args.push('--sandbox', sandbox)
    }

    if (model) args.push('--model', model)
    args.push('-C', cwd)

    if (instructionsFile) {
      args.push('-c', `model_instructions_file="${instructionsFile}"`)
    }

    // Prompt via stdin (use `-` to read from stdin)
    args.push('-')

    const events: CodexEvent[] = []
    const textParts: string[] = []

    try {
      const result = await runCodexProcess(binary, args, prompt, options?.signal)

      // Parse JSONL events
      for (const line of result.stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed) as CodexEvent
          events.push(event)
        } catch {
          // non-JSON line, skip
        }
      }

      // Extract text from events
      let inputTokens = 0
      let outputTokens = 0
      let errorMessage: string | undefined

      for (const event of events) {
        if (event.type === 'item.completed') {
          if (event.item.type === 'agent_message' && event.item.text) {
            textParts.push(event.item.text)
          } else if (event.item.type === 'file_change' && event.item.changes) {
            const changes = event.item.changes
              .map((c) => `${c.kind}: ${c.path}`)
              .join(', ')
            textParts.push(`[File changes: ${changes}]`)
          } else if (event.item.type === 'shell_command' && event.item.text) {
            textParts.push(`[Command: ${event.item.text}]`)
          } else if (event.item.type === 'error') {
            errorMessage = event.item.message || event.item.text || 'Unknown error'
          }
        } else if (event.type === 'turn.completed' && event.usage) {
          inputTokens = event.usage.input_tokens
          outputTokens = event.usage.output_tokens
        } else if (event.type === 'turn.failed') {
          errorMessage = event.error.message
        } else if (event.type === 'error') {
          errorMessage = event.message
        }
      }

      const content = textParts.join('\n\n') || errorMessage || ''
      const finishReason = errorMessage && textParts.length === 0 ? 'error' : 'stop'

      return {
        content,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        model: model ?? 'codex-default',
        finishReason,
      }
    } finally {
      // Cleanup temp file
      if (instructionsFile) {
        await unlink(instructionsFile).catch(() => {})
      }
    }
  }

  return {
    name: `codex${model ? ':' + model : ''}`,
    capabilities,
    generate,
  }
}

// ─── Process runner ──────────────────────────────────────────────────────────

function runCodexProcess(
  binary: string,
  args: string[],
  stdin: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    // Write prompt to stdin and close
    proc.stdin.write(stdin)
    proc.stdin.end()

    proc.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })

    proc.on('error', (err: Error) => {
      reject(new Error(`Codex process error: ${err.message}`))
    })

    // Handle abort signal
    if (signal) {
      const onAbort = () => {
        proc.kill('SIGTERM')
        reject(new Error('Codex: aborted'))
      }
      if (signal.aborted) {
        proc.kill('SIGTERM')
        reject(new Error('Codex: aborted'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      proc.on('close', () => signal.removeEventListener('abort', onAbort))
    }
  })
}
