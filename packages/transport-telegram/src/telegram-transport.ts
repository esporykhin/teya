/**
 * @description Telegram bot transport — grammy, long polling, message splitting
 * @exports TelegramTransport
 */
import { Bot } from 'grammy'
import type { Transport, AgentEvent } from '@teya/core'

export class TelegramTransport implements Transport {
  private bot: Bot
  private messageHandler: ((message: string, sessionId: string) => void) | null = null
  private cancelHandler: ((sessionId: string) => void) | null = null
  private responseBuffers: Map<string, string> = new Map()  // chatId -> accumulated text
  private allowedChatIds?: Set<number>  // whitelist, if set
  private sessionStats: Map<string, { turns: number; cost: number; startTime: number }> = new Map()
  ready = true

  constructor(config: { token: string; allowedChatIds?: number[] }) {
    this.bot = new Bot(config.token)
    if (config.allowedChatIds?.length) {
      this.allowedChatIds = new Set(config.allowedChatIds)
    }
  }

  onMessage(handler: (message: string, sessionId: string) => void): void {
    this.messageHandler = handler
  }

  onCancel(handler: (sessionId: string) => void): void {
    this.cancelHandler = handler
  }

  async send(event: AgentEvent, sessionId: string): Promise<void> {
    const chatId = sessionId  // sessionId = chatId for telegram

    switch (event.type) {
      case 'thinking_start':
        // Send typing indicator
        try { await this.bot.api.sendChatAction(Number(chatId), 'typing') } catch {}
        break

      case 'thinking_end': {
        const stats = this.sessionStats.get(sessionId) || { turns: 0, cost: 0, startTime: Date.now() }
        stats.turns++
        this.sessionStats.set(sessionId, stats)
        break
      }

      case 'response': {
        // Send the full response, split if > 4096 chars
        const text = event.content || '(empty response)'
        await this.sendLongMessage(Number(chatId), text)
        break
      }

      case 'tool_start':
        // Optional: show what tool is being used
        // Don't spam — only show for slow tools
        break

      case 'tool_result':
        // Don't show raw tool results to user
        break

      case 'tool_error':
        await this.safeSend(Number(chatId), `Tool error: ${event.tool} — ${event.error}`)
        break

      case 'error':
        await this.safeSend(Number(chatId), `Error (${event.phase}): ${event.error}`)
        break

      case 'cancelled':
        await this.safeSend(Number(chatId), 'Cancelled.')
        break

      case 'max_turns_reached':
        await this.safeSend(Number(chatId), `Reached max turns (${event.turns}).`)
        break

      case 'budget_exceeded':
        await this.safeSend(Number(chatId), `Budget exceeded ($${event.cost.toFixed(4)}).`)
        break

      case 'plan_proposed': {
        const planText = event.steps
          .map((s: { description: string; tools?: string[]; estimatedCost?: number }, i: number) => `${i + 1}. ${s.description}`)
          .join('\n')
        await this.safeSend(Number(chatId), `Plan:\n${planText}`)
        break
      }

      case 'ask_user':
        await this.safeSend(Number(chatId), event.question)
        break

      case 'intermediate_response':
        await this.safeSend(Number(chatId), event.content)
        break
    }
  }

  async start(): Promise<void> {
    // Handle text messages
    this.bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id
      const text = ctx.message.text.trim()

      // Whitelist check
      if (this.allowedChatIds && !this.allowedChatIds.has(chatId)) {
        await ctx.reply('Access denied.')
        return
      }

      // Commands
      if (text === '/stop') {
        this.cancelHandler?.(String(chatId))
        await ctx.reply('Stopping current task...')
        return
      }
      if (text === '/new') {
        await ctx.reply('New session started.')
        return
      }
      if (text === '/start') {
        await ctx.reply('Teya Agent ready. Send me a message.')
        return
      }
      if (text === '/status') {
        const stats = this.sessionStats.get(String(chatId))
        if (stats) {
          const elapsed = Math.floor((Date.now() - stats.startTime) / 1000)
          await ctx.reply(`Session: ${elapsed}s, ${stats.turns} turns`)
        } else {
          await ctx.reply('No active session.')
        }
        return
      }

      // Regular message
      if (this.messageHandler) {
        this.messageHandler(text, String(chatId))
      }
    })

    // Handle photos
    this.bot.on('message:photo', async (ctx) => {
      const chatId = ctx.chat.id
      if (this.allowedChatIds && !this.allowedChatIds.has(chatId)) return

      const caption = ctx.message.caption || 'User sent a photo'
      // For now, just treat as text message with description
      if (this.messageHandler) {
        this.messageHandler(`[Photo received: ${caption}]`, String(chatId))
      }
    })

    // Handle documents
    this.bot.on('message:document', async (ctx) => {
      const chatId = ctx.chat.id
      if (this.allowedChatIds && !this.allowedChatIds.has(chatId)) return

      const fileName = ctx.message.document?.file_name || 'unknown'
      const caption = ctx.message.caption || ''
      if (this.messageHandler) {
        this.messageHandler(`[Document received: ${fileName}${caption ? ' — ' + caption : ''}]`, String(chatId))
      }
    })

    console.log('Telegram bot starting...')
    await this.bot.start()
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }

  private async sendLongMessage(chatId: number, text: string): Promise<void> {
    const MAX_LENGTH = 4096
    if (text.length <= MAX_LENGTH) {
      await this.safeSend(chatId, text)
      return
    }

    // Split by paragraphs, then by lines, then by characters
    const chunks: string[] = []
    let current = ''
    for (const line of text.split('\n')) {
      if ((current + '\n' + line).length > MAX_LENGTH) {
        if (current) chunks.push(current)
        current = line.slice(0, MAX_LENGTH)
      } else {
        current = current ? current + '\n' + line : line
      }
    }
    if (current) chunks.push(current)

    for (const chunk of chunks) {
      await this.safeSend(chatId, chunk)
    }
  }

  private async safeSend(chatId: number, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' })
    } catch {
      // Markdown parse failed — retry without parse_mode
      try {
        await this.bot.api.sendMessage(chatId, text)
      } catch (err) {
        console.error(`Failed to send message to ${chatId}:`, err)
      }
    }
  }
}
