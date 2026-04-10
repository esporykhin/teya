/**
 * @description core:telegram — compound tool that exposes the full Telegram userbot
 *   surface (MTProto via GramJS) to the agent. Gives Teya the ability to send/read
 *   messages, files, browse channels, manage chats, contacts, etc.
 *
 * All actions operate on a single already-authenticated TelegramClient instance
 * (shared with TelegramUserbotTransport). Peers can be specified as:
 *   - username (with or without leading @)
 *   - phone number (+7...)
 *   - numeric id (user / chat / channel)
 *   - "me" / "self" → Saved Messages
 *
 * File paths for send_file / download_media are resolved via @teya/tools workspace
 * helpers so the agent cannot escape its sandbox.
 */
import type { ToolDefinition } from '@teya/core'
import { TelegramClient, Api } from 'telegram'
import { relative, resolve as resolvePath } from 'path'
import { CustomFile } from 'telegram/client/uploads.js'
import { readFile, stat, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import bigInt from 'big-integer'

export interface TelegramToolOptions {
  /**
   * Resolve a path provided by the agent to an absolute filesystem path.
   * Used for send_file / download_media. Must enforce sandboxing (reject
   * attempts to escape the workspace). If omitted — paths are treated as
   * absolute and workspaceRoot is used only for display.
   */
  resolvePath?: (path: string, mode: 'read' | 'write') => string
  workspaceRoot?: string
}

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
function arr<T = unknown>(v: unknown): T[] | undefined {
  return Array.isArray(v) ? (v as T[]) : undefined
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/** Normalize "me"/"self" / @username / phone / numeric id → value accepted by GramJS. */
function normalizePeer(peer: string): string | number {
  const p = peer.trim()
  if (!p) throw new Error('peer is empty')
  if (p === 'me' || p === 'self') return 'me'
  if (/^-?\d+$/.test(p)) return Number(p)
  if (p.startsWith('@')) return p.slice(1)
  return p
}

/** Compact, agent-friendly formatter for common Telegram entities. */
function formatEntity(e: any): string {
  if (!e) return '(none)'
  const type = e.className || (e._ as string) || 'Entity'
  const id = e.id?.toString?.() ?? String(e.id ?? '?')
  const parts = [`${type}#${id}`]
  if (e.username) parts.push(`@${e.username}`)
  if (e.firstName || e.lastName) parts.push([e.firstName, e.lastName].filter(Boolean).join(' '))
  if (e.title) parts.push(e.title)
  if (e.phone) parts.push(`+${e.phone}`)
  if (typeof e.participantsCount === 'number') parts.push(`${e.participantsCount} members`)
  if (e.verified) parts.push('verified')
  if (e.scam) parts.push('SCAM')
  return parts.join(' | ')
}

function formatMessage(m: any): string {
  if (!m) return '(none)'
  const id = m.id
  const date = m.date ? new Date(Number(m.date) * 1000).toISOString() : '?'
  const fromId = m.senderId?.toString?.() ?? m.fromId?.userId?.toString?.() ?? 'unknown'
  const out = m.out ? ' →' : ' ←'
  let body = (m.message as string) || ''
  if (m.media) {
    const mediaType = m.media.className || 'media'
    body = body ? `[${mediaType}] ${body}` : `[${mediaType}]`
  }
  if (body.length > 500) body = body.slice(0, 500) + '…'
  return `#${id} ${date}${out} from:${fromId}\n  ${body.replace(/\n/g, '\n  ')}`
}

function truncateJson(obj: unknown, max = 4000): string {
  const s = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
  return s.length > max ? s.slice(0, max) + `\n… (truncated, ${s.length} chars)` : s
}

/**
 * Recursively walk a JSON object and convert any sub-objects that have
 * a `_` or `className` field (e.g. `{ _: "InputUserSelf" }`) into the
 * corresponding `new Api.InputUserSelf(...)` instance so GramJS can
 * serialize them properly. Arrays are walked element-wise.
 */
function hydrateApiObjects(obj: any): any {
  if (obj === null || obj === undefined) return obj
  if (Array.isArray(obj)) return obj.map(hydrateApiObjects)
  if (typeof obj !== 'object') return obj

  const className = obj._ || obj.className
  if (className && typeof className === 'string') {
    // Resolve Api[ClassName] or Api.ns.ClassName
    const parts = className.split('.')
    let ctor: any = Api
    for (const p of parts) ctor = ctor?.[p]
    if (typeof ctor === 'function') {
      const { _, className: _cn, ...rest } = obj
      return new ctor(hydrateApiObjects(rest))
    }
  }

  // Plain object — recurse into values
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = hydrateApiObjects(v)
  }
  return out
}

// ─── main factory ────────────────────────────────────────────────────────────

export function createTelegramTool(
  client: TelegramClient,
  options: TelegramToolOptions = {},
): RegisteredTool {
  const resolve = options.resolvePath ?? ((p: string) => resolvePath(p))
  const root = options.workspaceRoot ?? process.cwd()
  return {
    name: 'core:telegram',
    description: `Full Telegram userbot control (MTProto). Acts from the signed-in user account.

Actions:
  Messaging:
    send_message       — {peer, text, reply_to?, silent?, parse_mode?}
    send_file          — {peer, path, caption?, force_document?, voice?, video_note?}
    edit_message       — {peer, message_id, text}
    delete_messages    — {peer, message_ids[], revoke?}
    forward_messages   — {from_peer, to_peer, message_ids[]}
    pin_message        — {peer, message_id, unpin?, notify?}
    send_reaction      — {peer, message_id, emoji}
    read_history       — {peer, max_id?}
    set_typing         — {peer, action?}            // typing|recording_voice|uploading_photo|cancel

  Reading:
    get_me             — {}
    resolve_peer       — {peer}
    get_dialogs        — {limit?, archived?}
    get_chat           — {peer}
    get_messages       — {peer, limit?, offset_id?, search?, from_user?, min_id?, max_id?}
    get_participants   — {peer, limit?, search?}
    download_media     — {peer, message_id, save_as}        // save_as is workspace-relative

  Chats/channels:
    join_chat          — {peer}                     // @username | invite hash
    leave_chat         — {peer}
    create_group       — {title, users[]}
    create_channel     — {title, about?, broadcast?, megagroup?}
    invite_users       — {peer, users[]}
    kick_user          — {peer, user}

  Contacts:
    get_contacts       — {}
    add_contact        — {phone, first_name, last_name?}
    search_contacts    — {query, limit?}

  Escape hatch:
    invoke_raw         — {method, params}           // e.g. method="messages.GetStickers"

Peer formats: "me"/"self" (Saved Messages), @username, phone (+7...), or numeric id.`,
    parameters: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', description: 'Action name (see description)' },
        peer: { type: 'string', description: 'Target peer (username, phone, id, or "me")' },
        from_peer: { type: 'string', description: 'Source peer (forward_messages)' },
        to_peer: { type: 'string', description: 'Destination peer (forward_messages)' },
        text: { type: 'string', description: 'Message text' },
        message_id: { type: 'number', description: 'Message id' },
        message_ids: { type: 'array', items: { type: 'number' }, description: 'Array of message ids' },
        reply_to: { type: 'number', description: 'Message id to reply to' },
        silent: { type: 'boolean', description: 'Send without notification' },
        parse_mode: { type: 'string', enum: ['md', 'markdown', 'html', 'none'], description: 'Text parse mode' },
        path: { type: 'string', description: 'Workspace-relative file path to upload' },
        save_as: { type: 'string', description: 'Workspace-relative path to save downloaded media' },
        caption: { type: 'string', description: 'Caption for send_file' },
        force_document: { type: 'boolean', description: 'Send as document instead of auto-detected media' },
        voice: { type: 'boolean', description: 'Send as voice message' },
        video_note: { type: 'boolean', description: 'Send as video note (round)' },
        revoke: { type: 'boolean', description: 'Delete for everyone (default true)' },
        unpin: { type: 'boolean', description: 'Unpin instead of pin' },
        notify: { type: 'boolean', description: 'Notify chat on pin' },
        emoji: { type: 'string', description: 'Emoji for reaction (e.g. "👍")' },
        max_id: { type: 'number', description: 'Read history up to this id / filter upper bound' },
        min_id: { type: 'number', description: 'Filter lower message id' },
        offset_id: { type: 'number', description: 'Pagination offset message id' },
        limit: { type: 'number', description: 'Max items to return' },
        search: { type: 'string', description: 'Full-text search filter' },
        from_user: { type: 'string', description: 'Filter by sender' },
        archived: { type: 'boolean', description: 'Include archived dialogs' },
        action_type: { type: 'string', description: 'Typing action: typing|recording_voice|uploading_photo|uploading_document|cancel' },
        title: { type: 'string', description: 'Title for create_group / create_channel' },
        about: { type: 'string', description: 'Channel description' },
        users: { type: 'array', items: { type: 'string' }, description: 'List of users (usernames/phones/ids)' },
        user: { type: 'string', description: 'Single user (kick_user)' },
        broadcast: { type: 'boolean', description: 'Create broadcast channel' },
        megagroup: { type: 'boolean', description: 'Create supergroup' },
        phone: { type: 'string', description: 'Phone number for add_contact' },
        first_name: { type: 'string', description: 'First name for add_contact' },
        last_name: { type: 'string', description: 'Last name for add_contact' },
        query: { type: 'string', description: 'Query for search_contacts' },
        method: { type: 'string', description: 'Raw MTProto method path for invoke_raw' },
        params: { type: 'object', description: 'Raw method params for invoke_raw' },
      },
      required: ['action'],
    },
    source: 'builtin' as const,
    cost: {
      latency: 'slow' as const,
      tokenCost: 'low' as const,
      sideEffects: true,
      reversible: false,
      external: true,
    },
    execute: async (args: Record<string, unknown>) => {
      if (!client.connected) {
        try { await client.connect() } catch (err) {
          return `Telegram client not connected: ${(err as Error).message}`
        }
      }

      const action = str(args.action)
      if (!action) return 'Missing "action" parameter.'

      try {
        switch (action) {
          // ─── messaging ─────────────────────────────────────────────
          case 'send_message': {
            const peer = str(args.peer); const text = str(args.text)
            if (!peer || text === undefined) return 'send_message: need peer and text'
            if (text.length > 4096) return `send_message: text too long (${text.length} chars, max 4096). Split into multiple messages.`
            const parseModeRaw = str(args.parse_mode)
            const parseMode = !parseModeRaw || parseModeRaw === 'none' ? undefined
              : parseModeRaw === 'html' ? 'html'
              : 'md'
            const sent = await client.sendMessage(normalizePeer(peer), {
              message: text,
              replyTo: num(args.reply_to),
              silent: bool(args.silent),
              parseMode: parseMode as any,
            })
            return `sent #${sent.id} to ${peer}`
          }

          case 'send_file': {
            const peer = str(args.peer); const path = str(args.path)
            if (!peer || !path) return 'send_file: need peer and path'
            const resolved = resolve(path, 'read')
            const stats = await stat(resolved)
            const data = await readFile(resolved)
            const name = path.split('/').pop() || 'file'
            const file = new CustomFile(name, stats.size, resolved, data)
            const sent = await client.sendFile(normalizePeer(peer), {
              file,
              caption: str(args.caption),
              forceDocument: bool(args.force_document),
              voiceNote: bool(args.voice),
              videoNote: bool(args.video_note),
            })
            return `sent file #${sent.id} (${stats.size} bytes) to ${peer}`
          }

          case 'edit_message': {
            const peer = str(args.peer); const id = num(args.message_id); const text = str(args.text)
            if (!peer || id === undefined || text === undefined) return 'edit_message: need peer, message_id, text'
            const edited = await client.editMessage(normalizePeer(peer), { message: id, text })
            return `edited #${edited.id}`
          }

          case 'delete_messages': {
            const peer = str(args.peer); const ids = arr<number>(args.message_ids)
            if (!peer || !ids?.length) return 'delete_messages: need peer and message_ids[]'
            if (ids.length > 100) return `delete_messages: too many messages (${ids.length}, max 100). Split into batches.`
            const res = await client.deleteMessages(normalizePeer(peer), ids, { revoke: args.revoke !== false })
            return `deleted ${ids.length} messages (pts_count=${(res as any)?.[0]?.ptsCount ?? '?'})`
          }

          case 'forward_messages': {
            const from = str(args.from_peer); const to = str(args.to_peer); const ids = arr<number>(args.message_ids)
            if (!from || !to || !ids?.length) return 'forward_messages: need from_peer, to_peer, message_ids[]'
            if (ids.length > 100) return `forward_messages: too many messages (${ids.length}, max 100). Split into batches.`
            const forwarded = await client.forwardMessages(normalizePeer(to), {
              messages: ids,
              fromPeer: normalizePeer(from),
            })
            return `forwarded ${forwarded.length} messages ${from} → ${to}`
          }

          case 'pin_message': {
            const peer = str(args.peer); const id = num(args.message_id)
            if (!peer || id === undefined) return 'pin_message: need peer and message_id'
            if (args.unpin) {
              await client.unpinMessage(normalizePeer(peer), id)
              return `unpinned #${id}`
            }
            await client.pinMessage(normalizePeer(peer), id, { notify: bool(args.notify) })
            return `pinned #${id}`
          }

          case 'send_reaction': {
            const peer = str(args.peer); const id = num(args.message_id); const emoji = str(args.emoji)
            if (!peer || id === undefined || !emoji) return 'send_reaction: need peer, message_id, emoji'
            const entity = await client.getEntity(normalizePeer(peer))
            await client.invoke(new Api.messages.SendReaction({
              peer: entity,
              msgId: id,
              reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
            }))
            return `reacted ${emoji} on #${id}`
          }

          case 'read_history': {
            const peer = str(args.peer)
            if (!peer) return 'read_history: need peer'
            await client.markAsRead(normalizePeer(peer), num(args.max_id) as any)
            return `marked as read in ${peer}`
          }

          case 'set_typing': {
            const peer = str(args.peer); const t = str(args.action_type) || 'typing'
            if (!peer) return 'set_typing: need peer'
            const map: Record<string, any> = {
              typing: new Api.SendMessageTypingAction(),
              recording_voice: new Api.SendMessageRecordAudioAction(),
              uploading_photo: new Api.SendMessageUploadPhotoAction({ progress: 0 }),
              uploading_document: new Api.SendMessageUploadDocumentAction({ progress: 0 }),
              cancel: new Api.SendMessageCancelAction(),
            }
            const act = map[t] || map.typing
            const entity = await client.getEntity(normalizePeer(peer))
            await client.invoke(new Api.messages.SetTyping({ peer: entity, action: act }))
            return `typing=${t} in ${peer}`
          }

          // ─── reading ───────────────────────────────────────────────
          case 'get_me': {
            const me = await client.getMe()
            return formatEntity(me)
          }

          case 'resolve_peer': {
            const peer = str(args.peer)
            if (!peer) return 'resolve_peer: need peer'
            const entity = await client.getEntity(normalizePeer(peer))
            return formatEntity(entity)
          }

          case 'get_dialogs': {
            const limit = num(args.limit) ?? 30
            const dialogs = await client.getDialogs({ limit, archived: bool(args.archived) ?? false })
            if (!dialogs.length) return '(no dialogs)'
            return dialogs
              .map((d) => {
                const last = d.message?.message?.slice(0, 80) || '(no text)'
                const unread = d.unreadCount ? ` [unread=${d.unreadCount}]` : ''
                return `${formatEntity(d.entity)}${unread}\n  ↳ ${last}`
              })
              .join('\n')
          }

          case 'get_chat': {
            const peer = str(args.peer)
            if (!peer) return 'get_chat: need peer'
            const entity = await client.getEntity(normalizePeer(peer))
            return truncateJson(entity)
          }

          case 'get_messages': {
            const peer = str(args.peer)
            if (!peer) return 'get_messages: need peer'
            const limit = num(args.limit) ?? 20
            const messages = await client.getMessages(normalizePeer(peer), {
              limit,
              offsetId: num(args.offset_id),
              search: str(args.search),
              fromUser: str(args.from_user) ? normalizePeer(str(args.from_user)!) as any : undefined,
              minId: num(args.min_id),
              maxId: num(args.max_id),
            })
            if (!messages.length) return '(no messages)'
            return messages.map(formatMessage).join('\n\n')
          }

          case 'get_participants': {
            const peer = str(args.peer)
            if (!peer) return 'get_participants: need peer'
            const limit = num(args.limit) ?? 50
            const participants = await client.getParticipants(normalizePeer(peer), {
              limit,
              search: str(args.search),
            })
            if (!participants.length) return '(no participants)'
            return participants.map(formatEntity).join('\n')
          }

          case 'download_media': {
            const peer = str(args.peer); const id = num(args.message_id); const saveAs = str(args.save_as)
            if (!peer || id === undefined || !saveAs) return 'download_media: need peer, message_id, save_as'
            const messages = await client.getMessages(normalizePeer(peer), { ids: [id] })
            const msg = messages[0]
            if (!msg || !msg.media) return `no media in message #${id}`
            const resolved = resolve(saveAs, 'write')
            const buf = await client.downloadMedia(msg, {})
            if (!buf) return 'download returned empty'
            await mkdir(dirname(resolved), { recursive: true })
            await writeFile(resolved, buf as Buffer)
            const rel = relative(root, resolved)
            return `saved ${rel} (${(buf as Buffer).length} bytes)`
          }

          // ─── chats / channels ──────────────────────────────────────
          case 'join_chat': {
            const peer = str(args.peer)
            if (!peer) return 'join_chat: need peer'
            const trimmed = peer.trim()
            if (trimmed.startsWith('https://t.me/+') || trimmed.startsWith('+')) {
              const hash = trimmed.replace('https://t.me/+', '').replace(/^\+/, '')
              await client.invoke(new Api.messages.ImportChatInvite({ hash }))
              return `joined via invite ${hash}`
            }
            const entity = await client.getEntity(normalizePeer(trimmed))
            await client.invoke(new Api.channels.JoinChannel({ channel: entity as any }))
            return `joined ${formatEntity(entity)}`
          }

          case 'leave_chat': {
            const peer = str(args.peer)
            if (!peer) return 'leave_chat: need peer'
            const entity = await client.getEntity(normalizePeer(peer))
            await client.invoke(new Api.channels.LeaveChannel({ channel: entity as any }))
            return `left ${formatEntity(entity)}`
          }

          case 'create_group': {
            const title = str(args.title); const users = arr<string>(args.users)
            if (!title || !users?.length) return 'create_group: need title and users[]'
            const entities = await Promise.all(users.map((u) => client.getEntity(normalizePeer(u))))
            const result = await client.invoke(new Api.messages.CreateChat({ title, users: entities as any }))
            return `created group "${title}"\n${truncateJson(result)}`
          }

          case 'create_channel': {
            const title = str(args.title)
            if (!title) return 'create_channel: need title'
            const result = await client.invoke(new Api.channels.CreateChannel({
              title,
              about: str(args.about) || '',
              broadcast: bool(args.broadcast) || undefined,
              megagroup: bool(args.megagroup) || undefined,
            }))
            return `created channel "${title}"\n${truncateJson(result)}`
          }

          case 'invite_users': {
            const peer = str(args.peer); const users = arr<string>(args.users)
            if (!peer || !users?.length) return 'invite_users: need peer and users[]'
            const channel = await client.getEntity(normalizePeer(peer))
            const entities = await Promise.all(users.map((u) => client.getEntity(normalizePeer(u))))
            await client.invoke(new Api.channels.InviteToChannel({
              channel: channel as any,
              users: entities as any,
            }))
            return `invited ${users.length} users to ${peer}`
          }

          case 'kick_user': {
            const peer = str(args.peer); const user = str(args.user)
            if (!peer || !user) return 'kick_user: need peer and user'
            const channel = await client.getEntity(normalizePeer(peer))
            const target = await client.getEntity(normalizePeer(user))
            await client.invoke(new Api.channels.EditBanned({
              channel: channel as any,
              participant: target as any,
              bannedRights: new Api.ChatBannedRights({
                untilDate: 0,
                viewMessages: true,
              }),
            }))
            return `kicked ${user} from ${peer}`
          }

          // ─── contacts ──────────────────────────────────────────────
          case 'get_contacts': {
            const result = await client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }))
            const users = (result as any).users || []
            if (!users.length) return '(no contacts)'
            return users.map(formatEntity).join('\n')
          }

          case 'add_contact': {
            const phone = str(args.phone); const firstName = str(args.first_name)
            if (!phone || !firstName) return 'add_contact: need phone and first_name'
            const result = await client.invoke(new Api.contacts.ImportContacts({
              contacts: [new Api.InputPhoneContact({
                clientId: bigInt(Date.now()),
                phone,
                firstName,
                lastName: str(args.last_name) || '',
              })],
            }))
            return `imported contact\n${truncateJson(result)}`
          }

          case 'search_contacts': {
            const query = str(args.query)
            if (!query) return 'search_contacts: need query'
            const limit = num(args.limit) ?? 10
            const result = await client.invoke(new Api.contacts.Search({ q: query, limit }))
            const users = (result as any).users || []
            return users.length ? users.map(formatEntity).join('\n') : '(no matches)'
          }

          // ─── raw escape hatch ──────────────────────────────────────
          case 'invoke_raw': {
            const method = str(args.method)
            if (!method) return 'invoke_raw: need method (e.g. "messages.GetStickers")'
            const parts = method.split('.')
            let ctor: any = Api
            for (const p of parts) ctor = ctor?.[p]
            if (typeof ctor !== 'function') return `invoke_raw: method ${method} not found on Api`
            const hydratedParams = hydrateApiObjects(args.params || {})
            const instance = new ctor(hydratedParams)
            const result = await client.invoke(instance)
            return truncateJson(result)
          }

          default:
            return `Unknown action "${action}". See tool description for supported actions.`
        }
      } catch (err: any) {
        // FloodWait: Telegram rate-limit — either auto-retry (short wait) or inform the LLM
        const isFloodWait =
          typeof err?.errorMessage === 'string' && err.errorMessage.startsWith('FLOOD_WAIT') ||
          typeof err?.seconds === 'number'
        if (isFloodWait) {
          const seconds: number = err.seconds ?? (parseInt(String(err.errorMessage).replace(/\D/g, ''), 10) || 0)
          if (seconds > 0 && seconds <= 5) {
            await new Promise(resolve => setTimeout(resolve, seconds * 1000))
            try {
              // Single retry — re-run entire execute call is not practical here,
              // so we surface a retriable error so caller can re-invoke immediately.
              return `Rate limited. Waited ${seconds}s. Please retry the same action now.`
            } catch {}
          }
          return `Rate limited by Telegram. Retry after ${seconds}s.`
        }
        return `Telegram error (${action}): ${(err as Error).message}`
      }
    },
  }
}
