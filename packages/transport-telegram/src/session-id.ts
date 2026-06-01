/**
 * @description Composite session id encoding for Telegram conversations.
 *
 * Telegram doesn't have a single "thread" concept, so we synthesise one
 * from the (chat, topic, user) tuple based on chat type. Encoding is
 * stable so the same composite always maps to the same session, and
 * decoding lets `send()` recover the routing parameters (chat id +
 * thread id) from a sessionId returned by the agent layer.
 *
 * Format (single-bot, backward-compatible):
 *   tg:<chatId>                  → private 1:1, or group default fallback
 *   tg:<chatId>:t<threadId>      → forum supergroup topic
 *   tg:<chatId>:u<userId>        → non-topic group, per-author session
 *
 * Format (multiplexer — one process, many bots). A `b<botName>` segment is
 * inserted right after the chat id so `send()` can recover which bot instance
 * to write through. botName is restricted to [A-Za-z0-9_-] so it never
 * collides with the `t`/`u` segment markers or the `:` delimiter:
 *   tg:<chatId>:b<botName>
 *   tg:<chatId>:b<botName>:t<threadId>
 *   tg:<chatId>:b<botName>:u<userId>
 *
 * For forum supergroups with multiple authors per topic, the topic ID
 * wins (one session per topic, regardless of who's writing). That matches
 * the user's mental model: "this is the marketing thread, this is the
 * dev thread, treat them separately".
 */

export type ChatKind = 'private' | 'group' | 'supergroup' | 'channel'

export interface SessionIdInput {
  chatId: number | string
  chatKind: ChatKind
  /** Telegram message_thread_id — only present in forum supergroups. */
  threadId?: number
  /** User id — used for per-author split in non-topic groups. */
  userId?: number | string
  /**
   * Multiplexer only — name of the bot that owns this session. When present,
   * a `b<botName>` segment is encoded so send() can route back to the right
   * bot instance. Omit for the single-bot path (backward-compatible ids).
   */
  botName?: string
}

export interface ParsedSessionId {
  chatId: string
  threadId?: number
  userId?: string
  botName?: string
}

/** botName chars allowed in a session id (no `:`, no `t`/`u` ambiguity issues). */
const BOT_NAME_RE = /^[A-Za-z0-9_-]+$/

export function buildSessionId(input: SessionIdInput): string {
  const chat = String(input.chatId)
  if (input.botName && !BOT_NAME_RE.test(input.botName)) {
    throw new Error(`Invalid Telegram botName "${input.botName}": must match ${BOT_NAME_RE}`)
  }
  const botSeg = input.botName ? `:b${input.botName}` : ''
  // Forum topic always wins.
  if (input.threadId !== undefined && input.threadId !== null) {
    return `tg:${chat}${botSeg}:t${input.threadId}`
  }
  // Non-topic group: split per author so concurrent users get isolated state.
  if ((input.chatKind === 'group' || input.chatKind === 'supergroup') && input.userId !== undefined) {
    return `tg:${chat}${botSeg}:u${input.userId}`
  }
  // Private chat or fallback.
  return `tg:${chat}${botSeg}`
}

export function parseSessionId(sessionId: string): ParsedSessionId | null {
  if (!sessionId.startsWith('tg:')) return null
  const rest = sessionId.slice(3)
  const parts = rest.split(':')
  const chatId = parts[0]
  if (!chatId) return null
  const out: ParsedSessionId = { chatId }
  for (const part of parts.slice(1)) {
    if (part.startsWith('b')) {
      // botName segment (multiplexer). Distinct from t/u markers.
      out.botName = part.slice(1)
    } else if (part.startsWith('t')) {
      const t = parseInt(part.slice(1), 10)
      if (Number.isFinite(t)) out.threadId = t
    } else if (part.startsWith('u')) {
      out.userId = part.slice(1)
    }
  }
  return out
}
