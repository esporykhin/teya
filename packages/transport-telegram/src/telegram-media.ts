/**
 * @description Shared Telegram Bot-API helpers — media download (vision),
 *  voice/audio transcription, and outbound message sending with Markdown
 *  fallback + 4096-char splitting. Pure functions that operate on a passed-in
 *  grammY Bot + token, so both the single-bot TelegramTransport and the
 *  multi-bot TelegramMultiplexerTransport reuse the SAME implementation
 *  instead of duplicating it.
 * @exports downloadAsImage, downloadAndTranscribe, sendLongMessage, safeSend
 */
import type { Bot } from 'grammy'
import { InputFile } from 'grammy'
import type { MessageImage } from '@teya/core'
import { transcribeBuffer } from './transcribe.js'
import { writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join, extname } from 'path'

const MAX_MESSAGE_LENGTH = 4096

/** Absolute path of the temp directory where Telegram media files are saved. */
export const TEYA_TG_MEDIA_DIR = join(tmpdir(), 'teya-tg-media')

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** Download a Telegram file by file_id and return it as base64 + MIME type. */
export async function downloadAsImage(
  bot: Bot,
  token: string,
  fileId: string,
  mimeHint?: string,
): Promise<MessageImage | null> {
  try {
    const file = await bot.api.getFile(fileId)
    if (!file.file_path) return null
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const buf = Buffer.from(await resp.arrayBuffer())
    const ext = file.file_path.split('.').pop()?.toLowerCase() || 'jpg'
    const mimeType = mimeHint || MIME_BY_EXT[ext] || 'image/jpeg'
    return { data: buf.toString('base64'), mimeType }
  } catch {
    return null
  }
}

/**
 * Download a Telegram file by file_id to a local path under the OS temp dir and
 * return the absolute path (or null). Used by claude-agent bots, which pass file
 * PATHS to the agent (so its Read tool can open them) rather than base64 — the
 * same model as the reference Python gateway.
 */
export async function downloadToFile(
  bot: Bot,
  token: string,
  fileId: string,
  baseName: string,
  fallbackExt = '',
): Promise<string | null> {
  try {
    const file = await bot.api.getFile(fileId)
    if (!file.file_path) return null
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const buf = Buffer.from(await resp.arrayBuffer())
    const ext = extname(file.file_path) || fallbackExt
    const dir = TEYA_TG_MEDIA_DIR
    await mkdir(dir, { recursive: true })
    const safeBase = baseName.replace(/[^A-Za-z0-9._-]/g, '_')
    const out = join(dir, `${Date.now()}_${safeBase}${ext}`)
    await writeFile(out, buf)
    return out
  } catch {
    return null
  }
}

/** Download a Telegram voice/audio file and transcribe it via mlx_whisper. */
export async function downloadAndTranscribe(
  bot: Bot,
  token: string,
  fileId: string,
  ext = 'ogg',
): Promise<string | null> {
  try {
    const file = await bot.api.getFile(fileId)
    if (!file.file_path) return null
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const buf = Buffer.from(await resp.arrayBuffer())
    return await transcribeBuffer(buf, ext)
  } catch {
    return null
  }
}

/**
 * Send a message, trying Markdown first and falling back to plain text if
 * Telegram rejects the entities. Failures are swallowed (logged) so a single
 * bad message never crashes the poller.
 */
export async function safeSend(
  bot: Bot,
  chatId: number,
  text: string,
  threadId?: number,
): Promise<void> {
  const opts = threadId ? { message_thread_id: threadId } : undefined
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts })
  } catch {
    try {
      await bot.api.sendMessage(chatId, text, opts)
    } catch (err) {
      console.error(`Failed to send message to ${chatId}:`, err)
    }
  }
}

/** Split long text on line boundaries and send each chunk under the 4096 limit. */
export async function sendLongMessage(
  bot: Bot,
  chatId: number,
  text: string,
  threadId?: number,
): Promise<void> {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    await safeSend(bot, chatId, text, threadId)
    return
  }

  const chunks: string[] = []
  let current = ''
  const flush = () => { if (current) { chunks.push(current); current = '' } }
  for (const line of text.split('\n')) {
    // A single line can exceed the limit (long URL / base64 / minified blob).
    // Hard-split it into <=MAX pieces so we never silently drop the tail.
    if (line.length > MAX_MESSAGE_LENGTH) {
      flush()
      for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
        chunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH))
      }
      continue
    }
    if ((current + '\n' + line).length > MAX_MESSAGE_LENGTH) {
      flush()
      current = line
    } else {
      current = current ? current + '\n' + line : line
    }
  }
  flush()

  for (const chunk of chunks) {
    await safeSend(bot, chatId, chunk, threadId)
  }
}

/**
 * Supported outbound media markers that a claude-agent can embed in its reply:
 *
 *   [[tg-photo:/abs/path.jpg [optional caption]]]
 *   [[tg-video:/abs/path.mp4 [optional caption]]]
 *   [[tg-audio:/abs/path.mp3 [optional caption]]]
 *   [[tg-voice:/abs/path.ogg]]           — voice note (ogg/opus)
 *   [[tg-document:/abs/path.pdf [cap]]]  — any file sent as a document
 *   [[tg-sticker:/abs/path.webp]]        — sticker
 *
 * Markers are stripped from the text before sending. The remaining text (if
 * non-empty after trimming) is sent last as a regular message. Multiple markers
 * in one reply are all sent.
 *
 * Path must be absolute. Caption is everything after the first space inside the marker.
 */

type MediaKind = 'photo' | 'video' | 'audio' | 'voice' | 'document' | 'sticker'

interface MediaMarker {
  kind: MediaKind
  path: string
  caption?: string
}

const MARKER_RE = /\[\[tg-(photo|video|audio|voice|document|sticker):([^\]]+)\]\]/g

function parseMediaMarkers(text: string): { markers: MediaMarker[]; text: string } {
  const markers: MediaMarker[] = []
  const clean = text.replace(MARKER_RE, (_, kind, rest: string) => {
    const trimmed = rest.trim()
    const spaceIdx = trimmed.indexOf(' ')
    const path = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed
    const caption = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : undefined
    markers.push({ kind: kind as MediaKind, path, caption })
    return ''
  })
  return { markers, text: clean.trim() }
}

async function sendMedia(bot: Bot, chatId: number, marker: MediaMarker, threadId?: number): Promise<void> {
  const file = new InputFile(marker.path)
  const opts = threadId ? { message_thread_id: threadId } : undefined
  const cap = marker.caption
  switch (marker.kind) {
    case 'photo':
      await bot.api.sendPhoto(chatId, file, { caption: cap, ...opts })
      break
    case 'video':
      await bot.api.sendVideo(chatId, file, { caption: cap, ...opts })
      break
    case 'audio':
      await bot.api.sendAudio(chatId, file, { caption: cap, ...opts })
      break
    case 'voice':
      await bot.api.sendVoice(chatId, file, opts)
      break
    case 'document':
      await bot.api.sendDocument(chatId, file, { caption: cap, ...opts })
      break
    case 'sticker':
      await bot.api.sendSticker(chatId, file, opts)
      break
  }
}

/**
 * Send a claude-agent reply to a Telegram chat, handling all `[[tg-*:...]]` media
 * markers embedded in the text. Media is sent first (in order), then the remaining
 * text — if any — is sent as a regular message. Failures on individual media items
 * are caught and reported as inline text so they never crash the turn.
 */
export async function sendAgentReply(
  bot: Bot,
  chatId: number,
  reply: string,
  threadId?: number,
): Promise<void> {
  const { markers, text } = parseMediaMarkers(reply)
  for (const marker of markers) {
    try {
      await sendMedia(bot, chatId, marker, threadId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await safeSend(bot, chatId, `(не удалось отправить ${marker.kind}: ${marker.path} — ${msg.slice(0, 200)})`, threadId)
    }
  }
  if (text) await sendLongMessage(bot, chatId, text, threadId)
}
