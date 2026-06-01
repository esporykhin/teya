/**
 * @description Tests for the composite Telegram session id encoding.
 *
 * This is the rule that decides "what counts as a separate Teya session"
 * in Telegram. Getting it wrong means topics merge or per-author beседы
 * leak into each other, so it deserves explicit coverage.
 */
import { describe, it, expect } from 'vitest'
import { buildSessionId, parseSessionId } from '../src/session-id.js'

describe('Telegram session id encoding', () => {
  describe('private chats', () => {
    it('uses just chatId', () => {
      expect(buildSessionId({ chatId: 12345, chatKind: 'private' })).toBe('tg:12345')
    })

    it('ignores userId in private chats (sender = chat)', () => {
      expect(buildSessionId({ chatId: 12345, chatKind: 'private', userId: 99 })).toBe('tg:12345')
    })
  })

  describe('forum supergroups (topics)', () => {
    it('uses chatId:t<threadId> when threadId is set', () => {
      expect(buildSessionId({
        chatId: 12345,
        chatKind: 'supergroup',
        threadId: 678,
      })).toBe('tg:12345:t678')
    })

    it('topic id wins over user id (one topic = one session regardless of author)', () => {
      // This matters for the user's main use case: solo across multiple
      // topics in a personal supergroup. Each topic = separate session,
      // even if I'm the only writer.
      expect(buildSessionId({
        chatId: 12345,
        chatKind: 'supergroup',
        threadId: 678,
        userId: 99,
      })).toBe('tg:12345:t678')
    })
  })

  describe('non-topic groups (per-author)', () => {
    it('uses chatId:u<userId> when no threadId', () => {
      expect(buildSessionId({
        chatId: 12345,
        chatKind: 'group',
        userId: 99,
      })).toBe('tg:12345:u99')
    })

    it('falls back to chatId only when no userId either', () => {
      expect(buildSessionId({ chatId: 12345, chatKind: 'group' })).toBe('tg:12345')
    })
  })

  describe('parseSessionId', () => {
    it('parses private chat ids', () => {
      expect(parseSessionId('tg:12345')).toEqual({ chatId: '12345' })
    })

    it('parses topic ids', () => {
      expect(parseSessionId('tg:12345:t678')).toEqual({ chatId: '12345', threadId: 678 })
    })

    it('parses per-author ids', () => {
      expect(parseSessionId('tg:12345:u99')).toEqual({ chatId: '12345', userId: '99' })
    })

    it('returns null for non-telegram ids', () => {
      expect(parseSessionId('cli-session')).toBeNull()
      expect(parseSessionId('')).toBeNull()
    })
  })

  it('round-trips: build → parse → matches input', () => {
    const cases = [
      { chatId: 12345, chatKind: 'private' as const },
      { chatId: 12345, chatKind: 'supergroup' as const, threadId: 678 },
      { chatId: 12345, chatKind: 'group' as const, userId: 99 },
    ]
    for (const c of cases) {
      const id = buildSessionId(c)
      const parsed = parseSessionId(id)
      expect(parsed).not.toBeNull()
      expect(parsed?.chatId).toBe(String(c.chatId))
      if (c.threadId) expect(parsed?.threadId).toBe(c.threadId)
      if (c.userId !== undefined && !c.threadId) expect(parsed?.userId).toBe(String(c.userId))
    }
  })

  describe('multiplexer botName segment', () => {
    it('encodes botName for a private chat', () => {
      expect(buildSessionId({ chatId: 12345, chatKind: 'private', botName: 'teya' }))
        .toBe('tg:12345:bteya')
    })

    it('encodes botName before a topic segment', () => {
      expect(buildSessionId({ chatId: 12345, chatKind: 'supergroup', threadId: 678, botName: 'teya' }))
        .toBe('tg:12345:bteya:t678')
    })

    it('encodes botName before a per-author segment', () => {
      expect(buildSessionId({ chatId: 12345, chatKind: 'group', userId: 99, botName: 'ceo' }))
        .toBe('tg:12345:bceo:u99')
    })

    it('handles negative group chat ids with a botName', () => {
      // Telegram supergroup ids are negative; ":" split must still isolate them.
      const id = buildSessionId({ chatId: -1001234567890, chatKind: 'supergroup', threadId: 42, botName: 'ceo' })
      expect(id).toBe('tg:-1001234567890:bceo:t42')
      expect(parseSessionId(id)).toEqual({ chatId: '-1001234567890', botName: 'ceo', threadId: 42 })
    })

    it('omits botName segment when not provided (backward compatible)', () => {
      expect(buildSessionId({ chatId: 12345, chatKind: 'private' })).toBe('tg:12345')
      expect(parseSessionId('tg:12345')).toEqual({ chatId: '12345' })
    })

    it('rejects botNames with illegal characters (would corrupt routing)', () => {
      expect(() => buildSessionId({ chatId: 1, chatKind: 'private', botName: 'a:b' })).toThrow()
      expect(() => buildSessionId({ chatId: 1, chatKind: 'private', botName: 'has space' })).toThrow()
    })

    it('parse recovers botName so send() can pick the right bot instance', () => {
      expect(parseSessionId('tg:12345:bteya')).toEqual({ chatId: '12345', botName: 'teya' })
      expect(parseSessionId('tg:12345:bceo:t678')).toEqual({ chatId: '12345', botName: 'ceo', threadId: 678 })
      expect(parseSessionId('tg:12345:bceo:u99')).toEqual({ chatId: '12345', botName: 'ceo', userId: '99' })
    })

    it('two bots in the same chat produce distinct session ids', () => {
      const a = buildSessionId({ chatId: 12345, chatKind: 'private', botName: 'teya' })
      const b = buildSessionId({ chatId: 12345, chatKind: 'private', botName: 'ceo' })
      expect(a).not.toBe(b)
      expect(parseSessionId(a)?.botName).toBe('teya')
      expect(parseSessionId(b)?.botName).toBe('ceo')
    })

    it('round-trips with botName across all chat kinds', () => {
      const cases = [
        { chatId: 1, chatKind: 'private' as const, botName: 'teya' },
        { chatId: 2, chatKind: 'supergroup' as const, threadId: 7, botName: 'teya' },
        { chatId: 3, chatKind: 'group' as const, userId: 8, botName: 'ceo' },
      ]
      for (const c of cases) {
        const parsed = parseSessionId(buildSessionId(c))
        expect(parsed?.chatId).toBe(String(c.chatId))
        expect(parsed?.botName).toBe(c.botName)
        if (c.threadId) expect(parsed?.threadId).toBe(c.threadId)
        if (c.userId !== undefined && !c.threadId) expect(parsed?.userId).toBe(String(c.userId))
      }
    })
  })
})
