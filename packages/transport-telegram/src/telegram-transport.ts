/**
 * @description Telegram bot transport — grammy, long polling, message splitting,
 *  per-topic / per-author session routing for groups and forum supergroups.
 * @exports TelegramTransport
 */
import { Bot } from 'grammy'
import type { Transport, AgentEvent, MessageContext, MessageSender, MessageChat } from '@teya/core'
import { buildSessionId, parseSessionId, type ChatKind } from './session-id.js'

interface SessionStats {
  turns: number
  cost: number
  startTime: number
}

export class TelegramTransport implements Transport {
  private bot: Bot
  private messageHandler: ((message: string, ctx: MessageContext) => void) | null = null
  private cancelHandler: ((sessionId: string) => void) | null = null
  private allowedChatIds?: Set<number>
  private sessionStats: Map<string, SessionStats> = new Map()
  ready = true

  constructor(config: { token: string; allowedChatIds?: number[] }) {
    this.bot = new Bot(config.token)
    if (config.allowedChatIds?.length) {
      this.allowedChatIds = new Set(config.allowedChatIds)
    }
  }

  onMessage(handler: (message: string, ctx: MessageContext) => void): void {
    this.messageHandler = handler
  }

  onCancel(handler: (sessionId: string) => void): void {
    this.cancelHandler = handler
  }

  async send(event: AgentEvent, sessionId: string): Promise<void> {
    // Decode the routing parameters back from the composite session id.
    // This is the only way `send()` knows which Telegram thread to write to,
    // since the Transport interface only carries the opaque sessionId.
    const parsed = parseSessionId(sessionId)
    if (!parsed) return
    const chatId = Number(parsed.chatId)
    const threadId = parsed.threadId

    switch (event.type) {
      case 'thinking_start':
        try { await this.bot.api.sendChatAction(chatId, 'typing', threadId ? { message_thread_id: threadId } : undefined) } catch {}
        break

      case 'thinking_end': {
        const stats = this.sessionStats.get(sessionId) || { turns: 0, cost: 0, startTime: Date.now() }
        stats.turns++
        this.sessionStats.set(sessionId, stats)
        break
      }

      case 'response': {
        const text = event.content || '(empty response)'
        await this.sendLongMessage(chatId, text, threadId)
        break
      }

      case 'tool_error':
        await this.safeSend(chatId, `Tool error: ${event.tool} — ${event.error}`, threadId)
        break

      case 'error':
        await this.safeSend(chatId, `Error (${event.phase}): ${event.error}`, threadId)
        break

      case 'cancelled':
        await this.safeSend(chatId, 'Cancelled.', threadId)
        break

      case 'max_turns_reached':
        await this.safeSend(chatId, `Reached max turns (${event.turns}).`, threadId)
        break

      case 'budget_exceeded':
        await this.safeSend(chatId, `Budget exceeded ($${event.cost.toFixed(4)}).`, threadId)
        break

      case 'plan_proposed': {
        const planText = event.steps
          .map((s, i) => `${i + 1}. ${s.description}`)
          .join('\n')
        await this.safeSend(chatId, `Plan:\n${planText}`, threadId)
        break
      }

      case 'ask_user':
        await this.safeSend(chatId, event.question, threadId)
        break

      case 'intermediate_response':
        await this.safeSend(chatId, event.content, threadId)
        break
    }
  }

  async start(): Promise<void> {
    this.bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id
      const text = ctx.message.text.trim()

      if (this.allowedChatIds && !this.allowedChatIds.has(chatId)) {
        await ctx.reply('Access denied.')
        return
      }

      const route = this.routeFor(ctx)

      const threadId = route.chat?.threadId

      // Built-in commands handled at transport level (no async leak to agent).
      if (text === '/stop') {
        this.cancelHandler?.(route.sessionId)
        await this.safeSend(chatId, 'Stopping current task...', threadId)
        return
      }
      if (text === '/start') {
        await this.safeSend(chatId, 'Teya Agent ready. Send me a message.', threadId)
        return
      }
      if (text === '/status') {
        const stats = this.sessionStats.get(route.sessionId)
        if (stats) {
          const elapsed = Math.floor((Date.now() - stats.startTime) / 1000)
          await this.safeSend(chatId, `Session ${route.sessionId} — ${elapsed}s, ${stats.turns} turns`, threadId)
        } else {
          await this.safeSend(chatId, `No active session for ${route.sessionId}`, threadId)
        }
        return
      }

      // /clear and /compact are handled centrally in the CLI message
      // intercept (it has access to the session store). Just pass them through.
      if (this.messageHandler) {
        this.messageHandler(text, route)
      }
    })

    this.bot.on('message:photo', async (ctx) => {
      const chatId = ctx.chat.id
      if (this.allowedChatIds && !this.allowedChatIds.has(chatId)) return
      const route = this.routeFor(ctx)
      const caption = ctx.message.caption || 'User sent a photo'
      if (this.messageHandler) {
        this.messageHandler(`[Photo received: ${caption}]`, route)
      }
    })

    this.bot.on('message:document', async (ctx) => {
      const chatId = ctx.chat.id
      if (this.allowedChatIds && !this.allowedChatIds.has(chatId)) return
      const route = this.routeFor(ctx)
      const fileName = ctx.message.document?.file_name || 'unknown'
      const caption = ctx.message.caption || ''
      if (this.messageHandler) {
        this.messageHandler(`[Document received: ${fileName}${caption ? ' — ' + caption : ''}]`, route)
      }
    })

    console.log('Telegram bot starting...')
    await this.bot.start()
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }

  /**
   * Build the per-message MessageContext (sessionId + sender + chat metadata)
   * from a grammy update. This is the single place that decides "what's a
   * session" in Telegram — see session-id.ts for the encoding rules.
   */
  private routeFor(ctx: {
    chat: { id: number; type: string; title?: string }
    from?: { id: number; first_name?: string; last_name?: string; username?: string }
    message: { message_thread_id?: number }
  }): MessageContext {
    const chatKind = (ctx.chat.type as ChatKind) || 'private'
    const threadId = ctx.message.message_thread_id
    const userId = ctx.from?.id

    const sessionId = buildSessionId({
      chatId: ctx.chat.id,
      chatKind,
      threadId,
      userId,
    })

    const sender: MessageSender | undefined = ctx.from
      ? {
          id: String(ctx.from.id),
          displayName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || undefined,
          username: ctx.from.username || undefined,
        }
      : undefined

    const chat: MessageChat = {
      id: String(ctx.chat.id),
      kind: chatKind,
      title: ctx.chat.title,
      threadId,
    }

    return { sessionId, sender, chat }
  }

  private async sendLongMessage(chatId: number, text: string, threadId?: number): Promise<void> {
    const MAX_LENGTH = 4096
    if (text.length <= MAX_LENGTH) {
      await this.safeSend(chatId, text, threadId)
      return
    }

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
      await this.safeSend(chatId, chunk, threadId)
    }
  }

  private async safeSend(chatId: number, text: string, threadId?: number): Promise<void> {
    const opts = threadId ? { message_thread_id: threadId } : undefined
    try {
      await this.bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts })
    } catch {
      try {
        await this.bot.api.sendMessage(chatId, text, opts)
      } catch (err) {
        console.error(`Failed to send message to ${chatId}:`, err)
      }
    }
  }
}
