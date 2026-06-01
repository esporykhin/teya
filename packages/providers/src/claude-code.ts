/**
 * @description Claude Code CLI provider — wraps Anthropic Claude Code CLI as a black-box agent
 * @exports claudeCode
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
  MessageImage,
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

// ─── Arg builder ─────────────────────────────────────────────────────────────

/**
 * Build the argv for a `claude -p` turn. Two mutually-exclusive shapes:
 *  - agent mode (`agent` set): `--agent <name>`, NO `--append-system-prompt`
 *    (the agent's persona file is the system prompt — layering teya's would
 *    corrupt it).
 *  - plain mode: `--append-system-prompt <systemPrompt>` if provided.
 * Exported so the invariant ("agent ⇒ no system prompt flag") is unit-testable.
 */
export function buildClaudeCodeArgs(opts: {
  agent?: string
  model?: string
  systemPrompt?: string
  cwd: string
  skipPermissions: boolean
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  /** Reasoning effort → `claude --effort <level>` (native flag). */
  effort?: 'low' | 'medium' | 'high'
}): string[] {
  const args: string[] = ['-p', '--output-format', 'json']
  if (opts.model) args.push('--model', opts.model)
  if (opts.agent) {
    args.push('--agent', opts.agent)
    // Intentionally NO --append-system-prompt in agent mode.
  } else if (opts.systemPrompt) {
    args.push('--append-system-prompt', opts.systemPrompt)
  }
  args.push('--add-dir', opts.cwd)
  // Reasoning effort. `claude --effort <low|medium|high|...>` is a native CLI
  // flag (`claude --help`), so a direct 1:1 map. Omitted ⇒ claude's own default.
  if (opts.effort) args.push('--effort', opts.effort)
  if (opts.skipPermissions) {
    args.push('--dangerously-skip-permissions')
  } else if (opts.permissionMode && opts.permissionMode !== 'default') {
    args.push('--permission-mode', opts.permissionMode)
  }
  return args
}

// ─── Provider factory ────────────────────────────────────────────────────────

export function claudeCode(config: {
  model?: string
  cwd?: string
  binary?: string
  /**
   * Claude Code agent name (~/.claude/agents/<name>.md). When set, the provider
   * runs `claude --agent <name>` and DOES NOT pass --append-system-prompt: the
   * agent's own persona file IS the system prompt, so layering teya's on top
   * would corrupt it. Brains/tools/memory live entirely on the Claude side.
   */
  agent?: string
  /** `bypassPermissions` runs fully unattended (equivalent to --dangerously-skip-permissions). */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  /** Shortcut: if true, passes --dangerously-skip-permissions. Default: true. */
  dangerouslySkipPermissions?: boolean
  /** Reasoning effort → `claude --effort`. Omitted ⇒ claude default. */
  effort?: 'low' | 'medium' | 'high'
}): LLMProvider {
  const binary = config.binary ?? 'claude'
  const model = config.model ?? undefined // use claude default
  const cwd = config.cwd ?? process.cwd()
  const agent = config.agent
  const permissionMode = config.permissionMode
  const skipPermissions = config.dangerouslySkipPermissions ?? true
  const effort = config.effort

  const capabilities: ProviderCapabilities = {
    toolCalling: false, // claude code executes tools internally
    parallelToolCalls: false,
    streaming: false,
    vision: true,
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
    let prompt = buildPromptWithContext(request.messages)

    // Collect attached images from the last user message and dump them to
    // temp files so Claude Code's Read tool can pick them up. Paths are
    // appended to the prompt with an instruction to inspect them.
    const lastUserImages: MessageImage[] = (() => {
      for (let i = request.messages.length - 1; i >= 0; i--) {
        const m = request.messages[i]
        if (m.role === 'user') return m.images ?? []
      }
      return []
    })()

    const imageTempPaths: string[] = []
    for (let i = 0; i < lastUserImages.length; i++) {
      const img = lastUserImages[i]
      const ext = img.mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
      const p = join(tmpdir(), `teya-claude-img-${Date.now()}-${i}.${ext}`)
      await writeFile(p, Buffer.from(img.data, 'base64'))
      imageTempPaths.push(p)
    }

    if (imageTempPaths.length > 0) {
      const list = imageTempPaths.map((p) => `- ${p}`).join('\n')
      prompt =
        (prompt || '(see attached images)') +
        `\n\n<attached_images>\nThe user attached ${imageTempPaths.length} image(s). Read them with the Read tool before answering:\n${list}\n</attached_images>`
    }

    if (!prompt) {
      return {
        content: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: model ?? 'claude-code-default',
        finishReason: 'stop',
      }
    }

    const args = buildClaudeCodeArgs({
      agent,
      model,
      systemPrompt: request.systemPrompt,
      cwd,
      skipPermissions,
      permissionMode,
      effort,
    })

    try {
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
    } finally {
      for (const p of imageTempPaths) {
        await unlink(p).catch(() => {})
      }
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
    // Drop CLAUDECODE so a claude-inside-claude invocation doesn't get confused
    // (same as the claude-agent runner). Everything else inherits.
    const env = { ...process.env }
    delete env.CLAUDECODE
    const proc = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
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
