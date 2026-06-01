/**
 * @description Multi-bot Telegram Bot-API transport. Runs N grammY long-poll
 *  bots in ONE process — one bot per token — and tags every inbound message
 *  with the bot name so the host (CLI) can resolve the per-bot agent
 *  (cwd / SOUL / provider / model / allowed chats). Outbound routing recovers
 *  the bot from the composite session id (`tg:<chat>:b<botName>...`).
 *
 *  This is the OWNER'S CHOSEN model: all Telegram interaction lives in teya,
 *  and a new bot→agent is just another entry in ~/.teya/telegram.json.
 *
 *  Media / voice / message-splitting logic is shared with the single-bot
 *  TelegramTransport via telegram-media.ts — NOT duplicated here.
 * @exports TelegramMultiplexerTransport, MultiBotConfig
 */
import { Bot, InlineKeyboard } from 'grammy'
import type { Transport, AgentEvent, MessageContext, MessageSender, MessageChat, KeyboardButton } from '@teya/core'
import { buildSessionId, parseSessionId, type ChatKind } from './session-id.js'
import { downloadAsImage, downloadAndTranscribe, downloadToFile, sendLongMessage, safeSend, sendAgentReply, TEYA_TG_MEDIA_DIR } from './telegram-media.js'
import { ClaudeAgentRunner } from './claude-agent-runner.js'

/**
 * Per-bot config. A bot is EITHER a teya-native bot (host runs the teya
 * agentLoop via `messageHandler`) OR a claude-agent bot (`claudeAgent` is set →
 * the multiplexer drives `claude --agent <name>` inline and the host never sees
 * the message). The two modes are mutually exclusive; `claudeAgent` decides.
 */
export interface MultiBotConfig {
  /** Stable, url-safe bot name. Used as the session-id segment + agent key. */
  name: string
  /** Bot-API token for this bot. */
  token: string
  /** Optional allow-list of chat ids; empty/undefined = everyone allowed. */
  allowedChatIds?: number[]
  /**
   * Claude-agent mode. When set, this bot is a pure transport to a Claude Code
   * agent — the multiplexer downloads media, builds the prompt and runs
   * `claude --agent <name>` itself, returning the reply. teya stores nothing.
   */
  claudeAgent?: {
    /** Claude Code agent name (~/.claude/agents/<name>.md). */
    agent: string
    /** Working directory for the claude process. */
    cwd: string
    /** Optional model override (e.g. "opus", "sonnet"). */
    model?: string
    /** Reply sent to non-allow-listed chats. Default: "Access denied." */
    strangerReply?: string
    /** Override the claude binary (tests). */
    binary?: string
    /**
     * Grant `--add-dir /` (whole-filesystem read). OFF by default — a safe
     * claude-agent bot only reaches its `cwd`. Opt-in for owner agents that need
     * broad access. See ClaudeAgentRunner.addRootDir.
     */
    addRootDir?: boolean
    /** Reasoning effort → `claude --effort`. Omitted ⇒ claude default. */
    effort?: 'low' | 'medium' | 'high'
    /** Per-turn timeout ms for the claude subprocess. Omitted ⇒ runner default (120s). */
    timeoutMs?: number
  }
}

/**
 * SECURITY GATE. Authorize an inbound update by the HUMAN behind it (ctx.from.id),
 * never by chat.id. A group/channel chat.id is not a user identity and can match
 * nothing meaningful; channel_posts and anonymous group admins arrive with NO
 * `from` at all. Rules:
 *   - no allow-list   → open bot, everyone allowed (teya-native dev bots).
 *   - allow-list set, no fromId → DENY (channel_post / anonymous admin).
 *   - allow-list set  → allow iff fromId ∈ allow-list.
 */
function isDenied(allowed: Set<number> | undefined, fromId: number | undefined): boolean {
  if (!allowed) return false
  if (fromId == null) return true
  return !allowed.has(fromId)
}

/** A negative id is a group/supergroup/channel shape — never a private user id. */
function isGroupShapedId(id: number): boolean {
  return id < 0
}

/**
 * SECURITY (file→execution). For claude-agent bots we tell the agent to `Read` a
 * downloaded document. `Read` runs under --dangerously-skip-permissions, so a
 * malicious file type could be a vector. Only instruct "open via Read" for inert
 * data formats; anything else gets a neutral "received, not opening" note so the
 * agent decides explicitly rather than us auto-opening e.g. a .sh / .py / .html.
 */
const SAFE_DOC_EXTS = new Set([
  'pdf', 'txt', 'md', 'csv', 'json', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'gif',
])
const SAFE_DOC_MIME_PREFIXES = ['image/', 'text/']
const SAFE_DOC_MIMES = new Set([
  'application/pdf', 'text/csv', 'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
])

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** True iff the document is an inert format we may instruct the agent to open. */
function isSafeDocument(fileName: string, mime: string): boolean {
  const ext = extOf(fileName)
  if (ext && SAFE_DOC_EXTS.has(ext)) return true
  const m = mime.toLowerCase()
  if (SAFE_DOC_MIMES.has(m)) return true
  if (SAFE_DOC_MIME_PREFIXES.some((p) => m.startsWith(p))) return true
  return false
}

interface BotEntry {
  name: string
  bot: Bot
  token: string
  allowedChatIds?: Set<number>
  /** Present iff this is a claude-agent bot — drives `claude --agent` inline. */
  claudeRunner?: ClaudeAgentRunner
  /** Reply for non-allow-listed chats (claude-agent bots only). */
  strangerReply?: string
}

interface SessionStats {
  turns: number
  cost: number
  startTime: number
}

export class TelegramMultiplexerTransport implements Transport {
  private entries = new Map<string, BotEntry>()
  private messageHandler: ((message: string, ctx: MessageContext) => void) | null = null
  private cancelHandler: ((sessionId: string) => void) | null = null
  private callbackHandler: ((data: string, ctx: MessageContext) => void) | null = null
  private sessionStats: Map<string, SessionStats> = new Map()
  /** Resolves when stop() is called, so start() blocks like the single-bot transport. */
  private stopResolve: (() => void) | null = null
  ready = true

  constructor(configs: MultiBotConfig[]) {
    if (configs.length === 0) {
      throw new Error('TelegramMultiplexerTransport requires at least one bot config')
    }
    // Enforce unique names AND unique tokens up front — two pollers on the
    // same token => Telegram 409 getUpdates conflict.
    const seenNames = new Set<string>()
    const seenTokens = new Set<string>()
    for (const cfg of configs) {
      if (!cfg.name) throw new Error('Each Telegram bot config needs a non-empty name')
      if (!cfg.token) throw new Error(`Bot "${cfg.name}" has no token`)
      if (seenNames.has(cfg.name)) throw new Error(`Duplicate Telegram bot name: ${cfg.name}`)
      if (seenTokens.has(cfg.token)) {
        throw new Error(`Duplicate Telegram token across bots (would cause a 409 polling conflict): ${cfg.name}`)
      }
      seenNames.add(cfg.name)
      seenTokens.add(cfg.token)
      let claudeRunner: ClaudeAgentRunner | undefined
      if (cfg.claudeAgent) {
        if (!cfg.claudeAgent.agent) throw new Error(`Bot "${cfg.name}" claudeAgent.agent is empty`)
        if (!cfg.claudeAgent.cwd) throw new Error(`Bot "${cfg.name}" claudeAgent.cwd is empty`)
        // SECURITY: a claude-agent bot authorizes by from.id (a positive user id).
        // A negative (group/channel-shaped) id in the allow-list would match
        // nothing the gate ever sees → either a dead bot, or worse, a foot-gun if
        // someone "fixes" it by falling back to chat.id. Reject at startup with a
        // clear message so the owner puts a USER id there, not a group id.
        const groupIds = (cfg.allowedChatIds || []).filter(isGroupShapedId)
        if (groupIds.length) {
          throw new Error(
            `Bot "${cfg.name}" (claude-agent) has group-shaped ids in allowed_chat_ids: ${groupIds.join(', ')}. ` +
            `claude-agent bots authorize by the human's user id (from.id, always positive). ` +
            `Put each ALLOWED USER's numeric id here, not a group/channel id.`,
          )
        }
        claudeRunner = new ClaudeAgentRunner({
          agent: cfg.claudeAgent.agent,
          cwd: cfg.claudeAgent.cwd,
          model: cfg.claudeAgent.model,
          binary: cfg.claudeAgent.binary,
          addRootDir: cfg.claudeAgent.addRootDir,
          extraDirs: cfg.claudeAgent.addRootDir ? undefined : [TEYA_TG_MEDIA_DIR],
          effort: cfg.claudeAgent.effort,
          timeoutMs: cfg.claudeAgent.timeoutMs,
        })
      }
      this.entries.set(cfg.name, {
        name: cfg.name,
        bot: new Bot(cfg.token),
        token: cfg.token,
        allowedChatIds: cfg.allowedChatIds?.length ? new Set(cfg.allowedChatIds) : undefined,
        claudeRunner,
        strangerReply: cfg.claudeAgent?.strangerReply,
      })
    }
  }

  /** Names of all configured bots — useful for diagnostics / startup logging. */
  botNames(): string[] {
    return [...this.entries.keys()]
  }

  onMessage(handler: (message: string, ctx: MessageContext) => void): void {
    this.messageHandler = handler
  }

  onCancel(handler: (sessionId: string) => void): void {
    this.cancelHandler = handler
  }

  onCallback(handler: (data: string, ctx: MessageContext) => void): void {
    this.callbackHandler = handler
  }

  /** Resolve the bot entry that should send to the given session id. */
  private entryForSession(sessionId: string): BotEntry | null {
    const parsed = parseSessionId(sessionId)
    if (!parsed?.botName) return null
    return this.entries.get(parsed.botName) || null
  }

  async sendKeyboard(sessionId: string, text: string, buttons: KeyboardButton[][]): Promise<void> {
    const parsed = parseSessionId(sessionId)
    if (!parsed) return
    const entry = this.entryForSession(sessionId)
    if (!entry) return
    const chatId = Number(parsed.chatId)
    const threadId = parsed.threadId

    const kb = new InlineKeyboard()
    for (const row of buttons) {
      for (const btn of row) kb.text(btn.label, btn.callbackData)
      kb.row()
    }

    const opts: Record<string, unknown> = { reply_markup: kb }
    if (threadId) opts.message_thread_id = threadId

    try {
      await entry.bot.api.sendMessage(chatId, text, opts as never)
    } catch (err) {
      console.error(`Failed to send keyboard to ${chatId} via ${entry.name}:`, err)
    }
  }

  async send(event: AgentEvent, sessionId: string): Promise<void> {
    const parsed = parseSessionId(sessionId)
    if (!parsed) return
    const entry = this.entryForSession(sessionId)
    if (!entry) return
    const bot = entry.bot
    const chatId = Number(parsed.chatId)
    const threadId = parsed.threadId

    switch (event.type) {
      case 'thinking_start':
        try { await bot.api.sendChatAction(chatId, 'typing', threadId ? { message_thread_id: threadId } : undefined) } catch {}
        break

      case 'thinking_end': {
        const stats = this.sessionStats.get(sessionId) || { turns: 0, cost: 0, startTime: Date.now() }
        stats.turns++
        this.sessionStats.set(sessionId, stats)
        break
      }

      case 'response': {
        const text = event.content || '(empty response)'
        await sendLongMessage(bot, chatId, text, threadId)
        break
      }

      case 'tool_error':
        await safeSend(bot, chatId, `Tool error: ${event.tool} — ${event.error}`, threadId)
        break

      case 'error':
        await safeSend(bot, chatId, `Error (${event.phase}): ${event.error}`, threadId)
        break

      case 'cancelled':
        await safeSend(bot, chatId, 'Cancelled.', threadId)
        break

      case 'max_turns_reached':
        await safeSend(bot, chatId, `Reached max turns (${event.turns}).`, threadId)
        break

      case 'budget_exceeded':
        await safeSend(bot, chatId, `Budget exceeded ($${event.cost.toFixed(4)}).`, threadId)
        break

      case 'plan_proposed': {
        const planText = event.steps.map((s, i) => `${i + 1}. ${s.description}`).join('\n')
        await safeSend(bot, chatId, `Plan:\n${planText}`, threadId)
        break
      }

      case 'ask_user':
        await safeSend(bot, chatId, event.question, threadId)
        break

      case 'intermediate_response':
        await safeSend(bot, chatId, event.content, threadId)
        break
    }
  }

  async start(): Promise<void> {
    for (const entry of this.entries.values()) {
      this.wireBot(entry)
    }
    console.log(`Telegram multiplexer starting (${this.entries.size} bots: ${this.botNames().join(', ')})...`)
    // bot.start() resolves only when the bot stops, so kick them off without
    // awaiting — all N pollers must run concurrently in this single process.
    for (const entry of this.entries.values()) {
      entry.bot.start({
        onStart: () => console.log(`  [${entry.name}] polling started`),
      }).catch((err) => console.error(`[${entry.name}] poller crashed:`, err))
    }
    // Block like the single-bot transport: start() stays pending until stop().
    await new Promise<void>((resolve) => { this.stopResolve = resolve })
  }

  async stop(): Promise<void> {
    await Promise.all([...this.entries.values()].map(e => e.bot.stop().catch(() => {})))
    this.stopResolve?.()
    this.stopResolve = null
  }

  /** Wire all grammY handlers for one bot, tagging routes with its name. */
  private wireBot(entry: BotEntry): void {
    if (entry.claudeRunner) {
      this.wireClaudeAgentBot(entry)
      return
    }
    const { bot, name, token, allowedChatIds } = entry

    bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id
      const text = ctx.message.text.trim()
      if (isDenied(allowedChatIds, ctx.from?.id)) {
        await ctx.reply('Access denied.')
        return
      }
      const route = this.routeFor(name, ctx)
      const threadId = route.chat?.threadId

      if (text === '/stop') {
        this.cancelHandler?.(route.sessionId)
        await safeSend(bot, chatId, 'Stopping current task...', threadId)
        return
      }
      if (text === '/start') {
        await safeSend(bot, chatId, 'Teya Agent ready. Send me a message.', threadId)
        return
      }
      if (text === '/status') {
        const stats = this.sessionStats.get(route.sessionId)
        if (stats) {
          const elapsed = Math.floor((Date.now() - stats.startTime) / 1000)
          await safeSend(bot, chatId, `Session ${route.sessionId} — ${elapsed}s, ${stats.turns} turns`, threadId)
        } else {
          await safeSend(bot, chatId, `No active session for ${route.sessionId}`, threadId)
        }
        return
      }

      this.messageHandler?.(text, route)
    })

    bot.on('message:photo', async (ctx) => {
      if (isDenied(allowedChatIds, ctx.from?.id)) return
      const route = this.routeFor(name, ctx)
      const caption = ctx.message.caption || ''
      const photos = ctx.message.photo
      const largest = photos[photos.length - 1]
      const img = largest ? await downloadAsImage(bot, token, largest.file_id, 'image/jpeg') : null
      this.messageHandler?.(caption || 'What do you see in this image?', {
        ...route,
        images: img ? [img] : undefined,
      })
    })

    bot.on('message:document', async (ctx) => {
      if (isDenied(allowedChatIds, ctx.from?.id)) return
      const route = this.routeFor(name, ctx)
      const doc = ctx.message.document
      const fileName = doc?.file_name || 'unknown'
      const caption = ctx.message.caption || ''
      const mime = doc?.mime_type || ''

      if (doc && mime.startsWith('image/')) {
        const img = await downloadAsImage(bot, token, doc.file_id, mime)
        this.messageHandler?.(caption || `What do you see in this image? (${fileName})`, {
          ...route,
          images: img ? [img] : undefined,
        })
        return
      }
      this.messageHandler?.(`[Document received: ${fileName}${caption ? ' — ' + caption : ''}]`, route)
    })

    bot.on('message:voice', async (ctx) => {
      if (isDenied(allowedChatIds, ctx.from?.id)) return
      const route = this.routeFor(name, ctx)
      const caption = ctx.message.caption || ''
      const voice = ctx.message.voice
      const transcript = voice ? await downloadAndTranscribe(bot, token, voice.file_id, 'ogg') : null
      const text = transcript
        ? `[Голосовое]: ${transcript}${caption ? '\n' + caption : ''}`
        : `[Голосовое сообщение]${caption ? ' — ' + caption : ''}`
      this.messageHandler?.(text, route)
    })

    bot.on('message:audio', async (ctx) => {
      if (isDenied(allowedChatIds, ctx.from?.id)) return
      const route = this.routeFor(name, ctx)
      const audio = ctx.message.audio
      const caption = ctx.message.caption || ''
      const ext = audio?.mime_type?.includes('ogg') ? 'ogg' : 'mp3'
      const transcript = audio ? await downloadAndTranscribe(bot, token, audio.file_id, ext) : null
      const text = transcript
        ? `[Аудио]: ${transcript}${caption ? '\n' + caption : ''}`
        : `[Аудио: ${audio?.file_name || 'файл'}]${caption ? ' — ' + caption : ''}`
      this.messageHandler?.(text, route)
    })

    bot.on('callback_query:data', async (ctx) => {
      const chat = ctx.chat
      if (!chat) {
        await ctx.answerCallbackQuery().catch(() => {})
        return
      }
      if (isDenied(allowedChatIds, ctx.from?.id)) {
        await ctx.answerCallbackQuery({ text: 'Access denied' }).catch(() => {})
        return
      }
      const cbMessage = ctx.callbackQuery.message
      const route = this.routeFor(name, {
        chat: { id: chat.id, type: chat.type, title: 'title' in chat ? chat.title : undefined },
        from: ctx.from,
        message: { message_thread_id: cbMessage?.message_thread_id },
      })
      await ctx.answerCallbackQuery().catch(() => {})
      this.callbackHandler?.(ctx.callbackQuery.data, route)
    })
  }

  /**
   * Wire a claude-agent bot. Unlike teya-native bots, this NEVER calls the host
   * messageHandler / teya agentLoop — the multiplexer downloads media, builds a
   * prompt, and drives `claude --agent <name>` inline via the bot's
   * ClaudeAgentRunner, keeping a continuous claude session per (bot,chat). All
   * brains/tools/memory live on the Claude Code side.
   */
  private wireClaudeAgentBot(entry: BotEntry): void {
    const { bot, name, token, allowedChatIds, claudeRunner, strangerReply } = entry
    const runner = claudeRunner!
    // SECURITY: this bot drives `claude --dangerously-skip-permissions`. The
    // ONLY thing standing between a stranger and arbitrary code execution on
    // the owner's machine is this gate. Authorize by ctx.from.id (the human),
    // NEVER by chat.id — a group/channel chat.id is not a user identity.
    const denied = (fromId?: number) => isDenied(allowedChatIds, fromId)

    /** Assemble the prompt for an inbound message, downloading any media. */
    const buildPrompt = async (
      msgCtx: {
        caption?: string
        text?: string
        photoFileId?: string
        voiceFileId?: string
        voiceExt?: string
        documentFileId?: string
        documentName?: string
        documentMime?: string
      },
      keyPrefix: string,
    ): Promise<string> => {
      const parts: string[] = []
      if (msgCtx.text) parts.push(msgCtx.text)
      else if (msgCtx.caption) parts.push(msgCtx.caption)

      if (msgCtx.voiceFileId) {
        const transcript = await downloadAndTranscribe(bot, token, msgCtx.voiceFileId, msgCtx.voiceExt || 'ogg')
        const path = transcript ? null : await downloadToFile(bot, token, msgCtx.voiceFileId, keyPrefix, '.oga')
        if (transcript) parts.push(`[Голосовое, транскрипция]: ${transcript}`)
        else if (path) parts.push(`[Голосовое: не распознано. Файл сохранён: ${path} — открой через Read]`)
        else parts.push('[Голосовое: не удалось скачать файл из Telegram]')
      }

      if (msgCtx.photoFileId) {
        const path = await downloadToFile(bot, token, msgCtx.photoFileId, keyPrefix, '.jpg')
        if (path) parts.push(`[Пользователь прислал картинку: ${path} (image/jpeg) — открой её через Read, чтобы посмотреть]`)
        else parts.push('[Картинка: не удалось скачать из Telegram]')
      }

      if (msgCtx.documentFileId) {
        const fname = msgCtx.documentName || keyPrefix
        const mime = msgCtx.documentMime || 'application/octet-stream'
        const path = await downloadToFile(bot, token, msgCtx.documentFileId, `${keyPrefix}_${fname}`)
        if (!path) {
          parts.push(`[Документ "${fname}": не удалось скачать из Telegram]`)
        } else if (isSafeDocument(fname, mime)) {
          parts.push(`[Пользователь прислал файл: ${path} (${mime}) — открой его через Read, чтобы посмотреть]`)
        } else {
          // Unsafe / unknown type: do NOT instruct an auto-open. Note it neutrally
          // and let the agent decide (it still has the path if it explicitly wants it).
          parts.push(`[Пользователь прислал файл типа ${mime} (имя: ${fname}), сохранён: ${path}. Не открываю автоматически — тип не входит в список безопасных.]`)
        }
      }

      return parts.join('\n').trim()
    }

    const runTurn = async (
      ctx: { chat: { id: number }; message?: { message_thread_id?: number } },
      route: MessageContext,
      prompt: string,
    ): Promise<void> => {
      const chatId = ctx.chat.id
      const threadId = route.chat?.threadId
      if (!prompt) {
        await safeSend(bot, chatId, '(пустое сообщение)', threadId)
        return
      }
      // Keep a typing indicator alive while claude thinks. The inter-ping wait is
      // CANCELLABLE: when the reply lands we resolve the pending sleep immediately
      // instead of blocking the loop for up to 5s after a fast answer.
      let typing = true
      let wakeSleep: (() => void) | null = null
      const cancellableSleep = (ms: number) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms)
          wakeSleep = () => { clearTimeout(t); resolve() }
        })
      const keepTyping = async () => {
        while (typing) {
          try { await bot.api.sendChatAction(chatId, 'typing', threadId ? { message_thread_id: threadId } : undefined) } catch {}
          if (!typing) break
          await cancellableSleep(5000)
        }
      }
      const typingPromise = keepTyping()
      try {
        const reply = await runner.run(route.sessionId, prompt)
        await sendAgentReply(bot, chatId, reply || '(пустой ответ)', threadId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[${name}] claude-agent error:`, msg)
        await safeSend(bot, chatId, `Ошибка агента: ${msg.slice(0, 500)}`, threadId)
      } finally {
        typing = false
        ;(wakeSleep as (() => void) | null)?.() // unblock the in-flight sleep so the loop exits now
        await typingPromise.catch(() => {})
      }
    }

    bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id
      const text = ctx.message.text.trim()
      const route = this.routeFor(name, ctx)
      const threadId = route.chat?.threadId
      if (denied(ctx.from?.id)) {
        if (strangerReply) await safeSend(bot, chatId, strangerReply, threadId)
        return
      }
      if (text === '/start') {
        await safeSend(bot, chatId, 'Готов. Напиши сообщение.', threadId)
        return
      }
      if (text === '/clear' || text === '/new') {
        runner.reset(route.sessionId)
        await safeSend(bot, chatId, 'Новая сессия начата.', threadId)
        return
      }
      await runTurn(ctx, route, text)
    })

    bot.on('message:photo', async (ctx) => {
      const chatId = ctx.chat.id
      const route = this.routeFor(name, ctx)
      if (denied(ctx.from?.id)) {
        if (strangerReply) await safeSend(bot, chatId, strangerReply, route.chat?.threadId)
        return
      }
      const photos = ctx.message.photo
      const largest = photos[photos.length - 1]
      const prompt = await buildPrompt({ caption: ctx.message.caption, photoFileId: largest?.file_id }, `${name}_photo`)
      await runTurn(ctx, route, prompt)
    })

    bot.on('message:voice', async (ctx) => {
      const chatId = ctx.chat.id
      const route = this.routeFor(name, ctx)
      if (denied(ctx.from?.id)) {
        if (strangerReply) await safeSend(bot, chatId, strangerReply, route.chat?.threadId)
        return
      }
      const prompt = await buildPrompt({ caption: ctx.message.caption, voiceFileId: ctx.message.voice?.file_id, voiceExt: 'ogg' }, `${name}_voice`)
      await runTurn(ctx, route, prompt)
    })

    bot.on('message:audio', async (ctx) => {
      const chatId = ctx.chat.id
      const route = this.routeFor(name, ctx)
      if (denied(ctx.from?.id)) {
        if (strangerReply) await safeSend(bot, chatId, strangerReply, route.chat?.threadId)
        return
      }
      const audio = ctx.message.audio
      const ext = audio?.mime_type?.includes('ogg') ? 'ogg' : 'mp3'
      const prompt = await buildPrompt({ caption: ctx.message.caption, voiceFileId: audio?.file_id, voiceExt: ext }, `${name}_audio`)
      await runTurn(ctx, route, prompt)
    })

    bot.on('message:document', async (ctx) => {
      const chatId = ctx.chat.id
      const route = this.routeFor(name, ctx)
      if (denied(ctx.from?.id)) {
        if (strangerReply) await safeSend(bot, chatId, strangerReply, route.chat?.threadId)
        return
      }
      const doc = ctx.message.document
      const prompt = await buildPrompt({
        caption: ctx.message.caption,
        documentFileId: doc?.file_id,
        documentName: doc?.file_name,
        documentMime: doc?.mime_type,
      }, `${name}_doc`)
      await runTurn(ctx, route, prompt)
    })
  }

  /**
   * Build the per-message MessageContext. Identical routing rules to the
   * single-bot transport, but the session id carries a `b<botName>` segment
   * and ctx.botName is set so the host can resolve the per-bot agent.
   */
  private routeFor(botName: string, ctx: {
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
      botName,
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

    return { sessionId, sender, chat, botName }
  }
}
