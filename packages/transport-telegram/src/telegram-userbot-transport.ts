/**
 * @description Telegram userbot transport — MTProto via GramJS, logs in as a real user account
 *   and lets Teya read/send messages from that account.
 * @exports TelegramUserbotTransport
 *
 * Trigger modes (configurable, can combine):
 *   - allowedChatIds + respondToIncoming  → Teya auto-replies to incoming messages
 *     in whitelisted chats (the peer writes to you, Teya answers as you).
 *   - triggerPrefix                       → Teya responds to YOUR own messages that
 *     start with the prefix (e.g. "!t write a polite refusal"). Useful inside any
 *     chat: you type "!t ..." and Teya takes over from that peer.
 *   - Default (no config)                 → only Saved Messages (self-chat) is active,
 *     which is the safest sandbox for testing.
 *
 * First-run auth is interactive (phone / SMS code / optional 2FA password).
 * After success the library prints a session string — store it in ~/.teya/config.json
 * as `telegramUserbotSession` to skip auth on subsequent runs.
 */
import type { Transport, AgentEvent, MessageContext, MessageSender, MessageChat } from '@teya/core'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js'
import * as readline from 'readline'
import { appendFile, rename, stat } from 'fs/promises'
import { join } from 'path'
import { buildSessionId, parseSessionId, type ChatKind } from './session-id.js'

export interface TelegramUserbotConfig {
  apiId: number
  apiHash: string
  /** StringSession payload. Empty string → interactive login on start(). */
  sessionString?: string
  /** Phone number (E.164 with leading +). If set, used as default in interactive login. */
  phone?: string
  /** Optional 2FA password. If set, used directly without prompting. */
  password?: string
  /** Whitelist of chat/peer IDs (as strings). If set, incoming messages in these chats will be routed to Teya. */
  allowedChatIds?: string[]
  /** Respond to incoming (non-outgoing) messages from whitelisted chats. Default: true if allowedChatIds set. */
  respondToIncoming?: boolean
  /** Trigger prefix for outgoing messages (e.g. "!t "). If present, Teya handles the message with the prefix stripped. */
  triggerPrefix?: string
  /** Called after successful login with the new session string so the caller can persist it. */
  onSession?: (sessionString: string) => void | Promise<void>
  /** Show typing indicator while the agent is thinking. Default: true. */
  showTyping?: boolean
  /** Device fingerprint — passed to Telegram so the session looks like a real client. */
  deviceModel?: string
  systemVersion?: string
  appVersion?: string
  langCode?: string
  systemLangCode?: string
  /** Connection retries (default 5). */
  connectionRetries?: number
}

export class TelegramUserbotTransport implements Transport {
  readonly client: TelegramClient
  private stringSession: StringSession
  private cfg: TelegramUserbotConfig
  private messageHandler: ((message: string, ctx: MessageContext) => Promise<void>) | null = null
  private cancelHandler: ((sessionId: string) => void) | null = null
  private allowedChatIds?: Set<string>
  private chatQueues: Map<string, { queue: Array<{ text: string; ctx: MessageContext }>; processing: boolean }> = new Map()
  private readonly logFile = join(process.env.HOME || process.env.USERPROFILE || '.', '.teya', 'telegram-userbot.log')
  readonly LOG_MAX_BYTES = 10 * 1024 * 1024  // 10 MB
  ready = false

  constructor(config: TelegramUserbotConfig) {
    this.cfg = config
    this.stringSession = new StringSession(config.sessionString ?? '')
    this.client = new TelegramClient(this.stringSession, config.apiId, config.apiHash, {
      connectionRetries: config.connectionRetries ?? 5,
      deviceModel: config.deviceModel ?? 'MacBookPro18,1',
      systemVersion: config.systemVersion ?? 'macOS 15.1',
      appVersion: config.appVersion ?? 'Teya 0.1.0',
      langCode: config.langCode ?? 'en',
      systemLangCode: config.systemLangCode ?? 'en',
      autoReconnect: true,
    })
    if (config.allowedChatIds?.length) {
      this.allowedChatIds = new Set(config.allowedChatIds.map(String))
    }
  }

  onMessage(handler: (message: string, ctx: MessageContext) => void): void {
    // Wrap sync handler to match internal async signature
    this.messageHandler = async (message, ctx) => { handler(message, ctx) }
  }

  onCancel(handler: (sessionId: string) => void): void {
    this.cancelHandler = handler
  }

  async start(): Promise<void> {
    await this.client.start({
      phoneNumber: async () => this.cfg.phone || ask('Phone number (with country code, e.g. +79991234567): '),
      password: async () => this.cfg.password || ask('2FA password (empty if none): ', true),
      phoneCode: async () => ask('Code from Telegram: '),
      onError: (err) => { console.error('[telegram-userbot] auth error:', err) },
    })

    const savedSession = this.stringSession.save()
    if (!this.cfg.sessionString && this.cfg.onSession) {
      await this.cfg.onSession(savedSession)
    }
    if (!this.cfg.sessionString) {
      console.log('\n[telegram-userbot] Signed in. Session string (save this!):')
      console.log(savedSession)
      console.log('')
    }

    const me = await this.client.getMe().catch(() => null)
    const selfName = me && 'firstName' in me ? me.firstName : 'unknown'
    console.log(`[telegram-userbot] Ready as ${selfName}`)

    this.client.addEventHandler(async (event: NewMessageEvent) => {
      try {
        await this.handleIncoming(event)
      } catch (err) {
        console.error('[telegram-userbot] handler error:', err)
      }
    }, new NewMessage({}))

    this.ready = true
  }

  async stop(): Promise<void> {
    this.ready = false
    try { await this.client.disconnect() } catch {}
  }

  async send(event: AgentEvent, sessionId: string): Promise<void> {
    // Sessions like "tg:<chat>:t<thread>" — recover routing parameters.
    const parsed = parseSessionId(sessionId)
    if (!parsed) return
    const peer = parsed.chatId
    const topMsgId = parsed.threadId

    switch (event.type) {
      case 'thinking_start':
        if (this.cfg.showTyping !== false) {
          try {
            await this.client.invoke(new Api.messages.SetTyping({
              peer,
              action: new Api.SendMessageTypingAction(),
              ...(topMsgId ? { topMsgId } : {}),
            } as any))
          } catch {}
        }
        break

      case 'response': {
        const text = event.content || '(empty response)'
        this.appendLog({ direction: 'out', chatId: peer, text })
        await this.sendLongMessage(peer, text, topMsgId)
        break
      }

      case 'intermediate_response':
        await this.safeSend(peer, event.content, topMsgId)
        break

      case 'ask_user':
        await this.safeSend(peer, event.question, topMsgId)
        break

      case 'tool_error':
        await this.safeSend(peer, `Tool error: ${event.tool} — ${event.error}`, topMsgId)
        break

      case 'error':
        await this.safeSend(peer, `Error (${event.phase}): ${event.error}`, topMsgId)
        break

      case 'cancelled':
        await this.safeSend(peer, 'Cancelled.', topMsgId)
        break

      case 'max_turns_reached':
        await this.safeSend(peer, `Reached max turns (${event.turns}).`, topMsgId)
        break

      case 'budget_exceeded':
        await this.safeSend(peer, `Budget exceeded ($${event.cost.toFixed(4)}).`, topMsgId)
        break

      case 'plan_proposed': {
        const planText = event.steps
          .map((s: { description: string }, i: number) => `${i + 1}. ${s.description}`)
          .join('\n')
        await this.safeSend(peer, `Plan:\n${planText}`, topMsgId)
        break
      }

      // thinking_end / tool_start / tool_result / messages_updated — silent
    }
  }

  // ───────────────────────────── internals ─────────────────────────────

  private async handleIncoming(event: NewMessageEvent): Promise<void> {
    const msg = event.message
    if (!msg || !msg.message) return

    const chatId = String(msg.chatId ?? msg.peerId?.toString() ?? '')
    if (!chatId) return

    const rawText = msg.message
    const isOutgoing = msg.out === true

    // Build the message context — sessionId, sender, chat metadata.
    const ctx = await this.buildContext(msg, chatId)

    // Commands (only from self, so they don't pollute others' chats)
    if (isOutgoing) {
      const trimmed = rawText.trim()
      if (trimmed === '/teya:stop') {
        this.cancelHandler?.(ctx.sessionId)
        await this.safeSend(chatId, 'Stopping current task...', ctx.chat?.threadId)
        return
      }
      if (trimmed === '/teya:ping') {
        await this.safeSend(chatId, 'pong', ctx.chat?.threadId)
        return
      }
    }

    // Routing — determine whether this message should reach Teya
    const trigger = this.cfg.triggerPrefix
    const respondIncoming = this.cfg.respondToIncoming ?? !!this.allowedChatIds

    let payload: string | null = null

    if (isOutgoing && trigger && rawText.startsWith(trigger)) {
      payload = rawText.slice(trigger.length).trim()
    } else if (!isOutgoing && respondIncoming) {
      if (this.allowedChatIds && !this.allowedChatIds.has(chatId)) return
      payload = rawText
    } else if (!this.allowedChatIds && !trigger) {
      // Safe default: only Saved Messages (self-chat).
      const me = await this.client.getMe().catch(() => null)
      const selfId = me && 'id' in me ? String(me.id) : null
      if (isOutgoing && selfId && chatId === selfId) {
        payload = rawText
      }
    }

    if (payload === null || !this.messageHandler) return

    this.appendLog({ direction: 'in', chatId, text: payload, messageId: msg.id })

    // Per-session queue (not per-chat) — different topics in the same forum
    // run independently. Same topic is still serialized so the agent doesn't
    // race against itself.
    let entry = this.chatQueues.get(ctx.sessionId)
    if (!entry) {
      entry = { queue: [], processing: false }
      this.chatQueues.set(ctx.sessionId, entry)
    }
    if (entry.processing) {
      entry.queue.push({ text: payload, ctx })
      return
    }
    entry.processing = true
    const processNext = async (text: string, mctx: MessageContext) => {
      try {
        await this.messageHandler!(text, mctx)
      } catch (err) {
        console.error('[telegram-userbot] messageHandler error:', err)
      }
      const next = entry!.queue.shift()
      if (next) {
        await processNext(next.text, next.ctx)
      } else {
        entry!.processing = false
      }
    }
    await processNext(payload, ctx)
  }

  /**
   * Recover the (sessionId, sender, chat) context from a raw MTProto message.
   * Forum topic detection looks at msg.replyTo.replyToTopId / forumTopic.
   */
  private async buildContext(msg: Api.Message, chatId: string): Promise<MessageContext> {
    // Chat kind — peerId tells us channel/chat/user, then we may need to
    // distinguish supergroup vs broadcast channel via the chat object.
    let chatKind: ChatKind = 'private'
    let title: string | undefined
    let isForum = false
    try {
      const peer = msg.peerId as { className?: string } | undefined
      if (peer?.className === 'PeerChat') {
        chatKind = 'group'
      } else if (peer?.className === 'PeerChannel') {
        chatKind = 'supergroup'
        // Look up channel info to detect forum / get title.
        try {
          const chat = await msg.getChat?.()
          if (chat) {
            // @ts-expect-error gramjs runtime
            title = chat.title
            // @ts-expect-error gramjs runtime
            if (chat.broadcast === true) chatKind = 'channel'
            // @ts-expect-error gramjs runtime
            if (chat.forum === true) isForum = true
          }
        } catch {}
      }
    } catch {}

    // Topic id — only meaningful when the chat is a forum supergroup.
    let threadId: number | undefined
    if (isForum) {
      const replyTo = msg.replyTo as { replyToTopId?: number; replyToMsgId?: number; forumTopic?: boolean } | undefined
      if (replyTo?.replyToTopId) {
        threadId = replyTo.replyToTopId
      } else if (replyTo?.forumTopic && replyTo?.replyToMsgId) {
        // The first message in a topic — the reply target IS the topic id.
        threadId = replyTo.replyToMsgId
      }
    }

    // Sender — only present in groups; in private chats fromId is undefined.
    let sender: MessageSender | undefined
    const fromId = msg.fromId as { userId?: number | string } | undefined
    if (fromId?.userId !== undefined) {
      const userIdStr = String(fromId.userId)
      sender = { id: userIdStr }
      try {
        const senderObj = await msg.getSender?.()
        if (senderObj) {
          // @ts-expect-error gramjs runtime
          const first = senderObj.firstName
          // @ts-expect-error gramjs runtime
          const last = senderObj.lastName
          // @ts-expect-error gramjs runtime
          const username = senderObj.username
          sender.displayName = [first, last].filter(Boolean).join(' ') || undefined
          sender.username = username || undefined
        }
      } catch {}
    }

    const sessionId = buildSessionId({
      chatId,
      chatKind,
      threadId,
      userId: sender?.id,
    })

    const chat: MessageChat = { id: chatId, kind: chatKind, title, threadId }
    return { sessionId, sender, chat }
  }

  private async sendLongMessage(peer: string, text: string, topMsgId?: number): Promise<void> {
    const MAX_LENGTH = 4096
    if (text.length <= MAX_LENGTH) {
      await this.safeSend(peer, text, topMsgId)
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
    for (const chunk of chunks) await this.safeSend(peer, chunk, topMsgId)
  }

  private async safeSend(peer: string, text: string, topMsgId?: number): Promise<void> {
    try {
      // Send into a forum topic by passing replyTo with the topic's top message id.
      const opts: { message: string; replyTo?: number } = { message: text }
      if (topMsgId) opts.replyTo = topMsgId
      await this.client.sendMessage(peer, opts)
    } catch (err) {
      console.error(`[telegram-userbot] send failed to ${peer}:`, err)
    }
  }

  /** Fire-and-forget JSONL log. Rotates file at 10 MB. */
  private appendLog(entry: { direction: 'in' | 'out'; chatId: string; text: string; messageId?: number }): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      direction: entry.direction,
      chatId: entry.chatId,
      text: entry.text.slice(0, 200),
      ...(entry.messageId !== undefined ? { messageId: entry.messageId } : {}),
    }) + '\n'

    // Async, fire-and-forget — do not await
    ;(async () => {
      try {
        // Rotate if > 10 MB
        const stats = await stat(this.logFile).catch(() => null)
        if (stats && stats.size > this.LOG_MAX_BYTES) {
          await rename(this.logFile, this.logFile + '.1').catch(() => {})
        }
        await appendFile(this.logFile, line, 'utf-8')
      } catch {
        // logging must never break message flow
      }
    })()
  }
}

function ask(question: string, silent = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    if (silent) {
      // hide input for password
      const stdout = process.stdout as unknown as { write: (s: string) => boolean }
      const origWrite = stdout.write.bind(stdout)
      ;(process.stdout as any).write = (chunk: string) => {
        if (chunk && chunk !== question) return true
        return origWrite(chunk)
      }
      rl.question(question, (answer) => {
        ;(process.stdout as any).write = origWrite
        process.stdout.write('\n')
        rl.close()
        resolve(answer.trim())
      })
    } else {
      rl.question(question, (answer) => {
        rl.close()
        resolve(answer.trim())
      })
    }
  })
}
