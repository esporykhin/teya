/**
 * @description Composite session id encoding for Telegram conversations.
 *
 * Telegram doesn't have a single "thread" concept, so we synthesise one
 * from the (chat, topic, user) tuple based on chat type. Encoding is
 * stable so the same composite always maps to the same session, and
 * decoding lets `send()` recover the routing parameters (chat id +
 * thread id) from a sessionId returned by the agent layer.
 *
 * Format:
 *   tg:<chatId>                  → private 1:1, or group default fallback
 *   tg:<chatId>:t<threadId>      → forum supergroup topic
 *   tg:<chatId>:u<userId>        → non-topic group, per-author session
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
}

export interface ParsedSessionId {
  chatId: string
  threadId?: number
  userId?: string
}

export function buildSessionId(input: SessionIdInput): string {
  const chat = String(input.chatId)
  // Forum topic always wins.
  if (input.threadId !== undefined && input.threadId !== null) {
    return `tg:${chat}:t${input.threadId}`
  }
  // Non-topic group: split per author so concurrent users get isolated state.
  if ((input.chatKind === 'group' || input.chatKind === 'supergroup') && input.userId !== undefined) {
    return `tg:${chat}:u${input.userId}`
  }
  // Private chat or fallback.
  return `tg:${chat}`
}

export function parseSessionId(sessionId: string): ParsedSessionId | null {
  if (!sessionId.startsWith('tg:')) return null
  const rest = sessionId.slice(3)
  const parts = rest.split(':')
  const chatId = parts[0]
  if (!chatId) return null
  const out: ParsedSessionId = { chatId }
  for (const part of parts.slice(1)) {
    if (part.startsWith('t')) {
      const t = parseInt(part.slice(1), 10)
      if (Number.isFinite(t)) out.threadId = t
    } else if (part.startsWith('u')) {
      out.userId = part.slice(1)
    }
  }
  return out
}
