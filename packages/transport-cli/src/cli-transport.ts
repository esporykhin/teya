/**
 * @description CLI transport — readline-based with image path detection and slash commands.
 * @exports CLITransport
 *
 * Image support: paste a screenshot path + comment, press Enter.
 * Path is detected, image loaded, sent with your comment to the agent.
 *
 * Example: /path/to/screenshot.png what's wrong here?
 */
import * as readline from 'readline'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Transport, AgentEvent, MessageImage } from '@teya/core'

const COMMANDS = [
  { name: '/clear',   description: 'New session + clear screen' },
  { name: '/stop',    description: 'Cancel current task' },
  { name: '/status',  description: 'Session info' },
  { name: '/tools',   description: 'List available tools' },
  { name: '/memory',  description: 'Memory stats' },
  { name: '/model',   description: 'Show/change model' },
  { name: '/help',    description: 'Show commands' },
  { name: '/compact', description: 'Clear context (keep session)' },
  { name: '/img',     description: 'Send clipboard image to agent' },
  { name: '/update',  description: 'Update Teya to latest version' },
  { name: '/exit',    description: 'Exit Teya' },
]

export interface AgentInfo {
  id: string
  description: string
}

export class CLITransport implements Transport {
  private rl: readline.Interface | null = null
  private messageHandler: ((message: string, sessionId: string, images?: MessageImage[]) => void) | null = null
  private cancelHandler: ((sessionId: string) => void) | null = null
  private commandHandler: ((command: string) => void | Promise<void>) | null = null
  private sessionId: string
  private agents: AgentInfo[] = []
  ready = true

  constructor(sessionId: string = 'cli-session') {
    this.sessionId = sessionId
  }

  /** Set available agents for @mention autocomplete */
  setAgents(agents: AgentInfo[]): void {
    this.agents = agents
  }

  onMessage(handler: (message: string, sessionId: string, images?: MessageImage[]) => void): void {
    this.messageHandler = handler
  }

  onCancel(handler: (sessionId: string) => void): void {
    this.cancelHandler = handler
  }

  onCommand(handler: (command: string) => void | Promise<void>): void {
    this.commandHandler = handler
  }

  setSessionId(id: string): void {
    this.sessionId = id
  }

  send(event: AgentEvent, _sessionId: string): void {
    switch (event.type) {
      case 'thinking_start':
        process.stdout.write(gray('Thinking...'))
        break
      case 'thinking_end':
        process.stdout.write(`\r${gray(`[${event.tokens.totalTokens} tokens]`)}\n`)
        break
      case 'content_delta':
        process.stdout.write(event.text)
        break
      case 'response':
        process.stdout.write('\n' + event.content + '\n\n')
        break
      case 'tool_start': {
        const argsStr = JSON.stringify(event.args).slice(0, 100)
        process.stdout.write(cyan(`  [tool] ${event.tool}(${argsStr})\n`))
        break
      }
      case 'tool_result': {
        const resultPreview = event.result.slice(0, 150).replace(/\n/g, ' ')
        process.stdout.write(green(`  [result] ${resultPreview}\n`))
        break
      }
      case 'tool_error':
        process.stdout.write(red(`  [error] ${event.tool}: ${event.error}\n`))
        break
      case 'tool_not_found':
        process.stdout.write(red(`  [error] Tool not found: ${event.tool}\n`))
        break
      case 'tool_denied':
        process.stdout.write(yellow(`  [denied] Tool denied: ${event.tool}\n`))
        break
      case 'ask_user':
        process.stdout.write(yellow(`\n? ${event.question}\n`))
        break
      case 'error':
        process.stdout.write(red(`\nError (${event.phase}): ${event.error}\n`))
        break
      case 'cancelled':
        process.stdout.write(yellow('\nCancelled.\n'))
        break
      case 'max_turns_reached':
        process.stdout.write(yellow(`\nMax turns reached (${event.turns}).\n`))
        break
      case 'budget_exceeded':
        process.stdout.write(yellow(`\nBudget exceeded ($${event.cost.toFixed(4)}).\n`))
        break
      case 'context_compacted':
        process.stdout.write(gray(`  [context] compacted ${event.before} -> ${event.after} tokens\n`))
        break
      case 'plan_proposed': {
        process.stdout.write(`\n${bold('Plan:')}\n`)
        for (let i = 0; i < event.steps.length; i++) {
          const step = event.steps[i]
          const tools = step.tools?.length ? ` ${gray(`[${step.tools.join(', ')}]`)}` : ''
          process.stdout.write(`  ${i + 1}. ${step.description}${tools}\n`)
        }
        process.stdout.write('\n')
        break
      }
      case 'plan_approved':
        process.stdout.write(green('  Plan approved — executing...\n\n'))
        break
      case 'plan_rejected':
        process.stdout.write(red(`  Plan rejected${event.reason ? ': ' + event.reason : ''}\n\n`))
        break
      case 'intermediate_response':
        process.stdout.write('\n' + cyan(event.content) + '\n\n')
        break
      case 'user_response':
        break
    }
  }

  async start(): Promise<void> {
    console.log(bold('Teya'))
    console.log(gray('Type your message. Paste image paths directly. Type / for commands.\n'))
    this.prompt()
    await new Promise(() => {})
  }

  async stop(): Promise<void> {
    this.rl?.close()
  }

  prompt(): void {
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }

    // Build completer for / commands and @agent mentions
    const completer = (line: string): [string[], string] => {
      // Find if we're completing an @mention
      const atMatch = line.match(/@(\w*)$/)
      if (atMatch) {
        const prefix = atMatch[1].toLowerCase()
        const hits = this.agents
          .filter(a => a.id.toLowerCase().startsWith(prefix))
          .map(a => line.slice(0, line.length - atMatch[0].length) + '@' + a.id + ' ')
        return [hits.length ? hits : [], line]
      }

      // Completing a / command at the start
      if (line.startsWith('/') && !line.includes(' ')) {
        const hits = COMMANDS
          .filter(c => c.name.startsWith(line))
          .map(c => c.name)
        return [hits.length ? hits : COMMANDS.map(c => c.name), line]
      }

      return [[], line]
    }

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer,
    })

    // Show agent hints when @ is typed
    if (this.agents.length > 0) {
      readline.emitKeypressEvents(process.stdin, this.rl)
      const hintHandler = (_ch: string | undefined, key: readline.Key) => {
        if (!this.rl) return
        const line = (this.rl as any).line as string
        // Detect @ just typed (at any position)
        if (line.endsWith('@')) {
          const hint = this.agents.map(a => `@${a.id}`).join('  ')
          // Print hint below, then restore cursor
          process.stdout.write(`\n${gray(hint)}`)
          // Move cursor back up to the input line
          process.stdout.write(`\x1b[1A\x1b[${line.length + 3}G`)
        }
      }
      process.stdin.on('keypress', hintHandler)
      // Clean up when this prompt session ends
      this.rl.once('close', () => {
        process.stdin.removeListener('keypress', hintHandler)
      })
    }

    this.rl.question(bold('> '), async (input) => {
      const trimmed = input.trim()
      if (!trimmed) {
        this.prompt()
        return
      }

      // Slash commands (only if no spaces = pure command, not a file path)
      if (trimmed.startsWith('/') && !trimmed.includes(' ') && !trimmed.includes('.')) {
        await this.handleCommand(trimmed)
        return
      }

      // Extract image paths from input
      const { text, images } = extractImagesFromInput(trimmed)

      if (images.length > 0) {
        const totalKB = images.reduce((sum, img) => sum + Math.round(img.data.length * 3 / 4 / 1024), 0)
        console.log(gray(`  ${images.length} image${images.length > 1 ? 's' : ''} (${totalKB} KB)`))
      }

      let message = text || (images.length > 0 ? 'What do you see in this image?' : trimmed)

      // Detect @agent mention — wrap as delegation instruction
      const agentMention = message.match(/^@(\w+)\s+(.+)$/s)
      if (agentMention) {
        const agentId = agentMention[1]
        const task = agentMention[2]
        const agent = this.agents.find(a => a.id.toLowerCase() === agentId.toLowerCase())
        if (agent) {
          console.log(gray(`  -> delegating to ${agent.id}`))
          message = `Delegate to agent "${agent.id}": ${task}`
        }
      }

      this.messageHandler?.(message, this.sessionId, images.length > 0 ? images : undefined)
    })
  }

  private async handleCommand(command: string): Promise<void> {
    if (command === '/stop') {
      this.cancelHandler?.(this.sessionId)
      this.prompt()
      return
    }
    if (command === '/exit') {
      console.log(gray('Goodbye.'))
      process.exit(0)
    }
    if (command === '/img') {
      const image = getClipboardImage()
      if (image) {
        const sizeKB = Math.round(image.data.length * 3 / 4 / 1024)
        console.log(gray(`  Clipboard image: ${sizeKB} KB`))
        this.messageHandler?.('Describe what you see in this image.', this.sessionId, [image])
      } else {
        console.log(yellow('No image in clipboard. Take a screenshot first (Cmd+Shift+4).\n'))
        this.prompt()
      }
      return
    }
    if (this.commandHandler) {
      await this.commandHandler(command)
    } else {
      console.log(gray(`Unknown command: ${command}\n`))
    }
    this.prompt()
  }
}

// ── Image extraction ─────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff']
const MIME_MAP: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.tiff': 'image/tiff',
}

/**
 * Find image file paths in input, load them, return cleaned text + images.
 * Handles paths with escaped spaces (Снимок\ экрана\ 2026...) and regular paths.
 */
function extractImagesFromInput(input: string): { text: string; images: MessageImage[] } {
  const images: MessageImage[] = []
  let remaining = input

  // Match paths: starts with / or ~, may contain escaped spaces (\ ), ends with image ext
  // The regex captures: /path/with\ spaces/file.png or /simple/path.jpg
  const pathRegex = /((?:\/|~\/)[^\n]*?\.(?:png|jpe?g|gif|webp|bmp|tiff))(?:\s|$)/gi
  let match

  while ((match = pathRegex.exec(input)) !== null) {
    let filePath = match[1].trim()
    // Unescape backslash-spaces
    filePath = filePath.replace(/\\ /g, ' ')
    // Expand ~
    if (filePath.startsWith('~/')) {
      filePath = join(process.env.HOME || '', filePath.slice(2))
    }

    try {
      if (!existsSync(filePath)) continue
      const data = readFileSync(filePath)
      if (data.length < 100) continue

      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
      const mimeType = MIME_MAP[ext] || 'image/png'
      images.push({ data: data.toString('base64'), mimeType })

      // Remove path from text
      remaining = remaining.replace(match[1], '').trim()
    } catch {
      // File not readable, skip
    }
  }

  // Clean up separators left behind (e.g. " - " or "  ")
  remaining = remaining.replace(/^\s*[-–—]\s*/, '').replace(/\s+/g, ' ').trim()

  return { text: remaining, images }
}

/**
 * Read image from macOS clipboard (Cmd+V when clipboard has screenshot).
 */
function getClipboardImage(): MessageImage | null {
  if (process.platform !== 'darwin') return null

  try {
    const { execSync } = require('child_process')
    const { mkdirSync } = require('fs')

    const info = execSync('osascript -e "clipboard info"', { encoding: 'utf-8', timeout: 3000 })
    if (!info.includes('PNGf') && !info.includes('TIFF') && !info.includes('public.png')) return null

    const tmpDir = join(process.env.HOME || '/tmp', '.teya', 'temp')
    mkdirSync(tmpDir, { recursive: true })
    const tmpPath = join(tmpDir, `clipboard-${Date.now()}.png`)

    try {
      execSync(`pngpaste "${tmpPath}" 2>/dev/null`, { timeout: 3000 })
    } catch {
      const script = `set theFile to POSIX file "${tmpPath}"
try
  set imgData to the clipboard as «class PNGf»
  set fileRef to open for access theFile with write permission
  write imgData to fileRef
  close access fileRef
on error
  try
    close access theFile
  end try
end try`
      execSync(`osascript -e '${script}'`, { timeout: 5000 })
    }

    if (!existsSync(tmpPath)) return null
    const data = readFileSync(tmpPath)
    if (data.length < 100) return null

    return { data: data.toString('base64'), mimeType: 'image/png' }
  } catch {
    return null
  }
}

// ANSI helpers
function gray(s: string): string { return `\x1b[90m${s}\x1b[0m` }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m` }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m` }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m` }
function cyan(s: string): string { return `\x1b[36m${s}\x1b[0m` }
function bold(s: string): string { return `\x1b[1m${s}\x1b[0m` }
