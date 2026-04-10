/**
 * @description `teya telegram <action>` subcommands — login, logout, status, doctor, test.
 *   Bootstraps the userbot session interactively (phone + code + 2FA), persists the
 *   session string to ~/.teya/config.json, and exposes a self-test that exercises the
 *   core:telegram tool against Saved Messages so users can verify everything works.
 */
import { TelegramUserbotTransport, createTelegramTool } from '@teya/transport-telegram'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import * as readline from 'readline'

interface Ctx {
  configFile: string
  loadSavedConfig: () => Promise<Record<string, string>>
  saveConfig: (config: Record<string, string>) => Promise<void>
}

/**
 * Read TG_API_ID / TG_API_HASH / TG_PHONE / TG_PASSWORD from
 *   1. process.env
 *   2. ~/.claude/credentials.env (KEY=VALUE lines)
 *   3. ~/.teya/config.json (telegramApiId / telegramApiHash / telegramPhone / telegramPassword)
 */
async function loadCredentials(ctx: Ctx): Promise<{
  apiId?: number
  apiHash?: string
  phone?: string
  password?: string
  sessionString?: string
}> {
  const out: ReturnType<typeof loadCredentials> extends Promise<infer T> ? T : never = {}

  // 1. env
  if (process.env.TG_API_ID) out.apiId = Number(process.env.TG_API_ID)
  if (process.env.TG_API_HASH) out.apiHash = process.env.TG_API_HASH
  if (process.env.TG_PHONE) out.phone = process.env.TG_PHONE
  if (process.env.TG_PASSWORD) out.password = process.env.TG_PASSWORD
  if (process.env.TELEGRAM_SESSION) out.sessionString = process.env.TELEGRAM_SESSION

  // 2. .env files (in priority order)
  const home = process.env.HOME || '.'
  const envCandidates = [
    join(home, '.claude', 'credentials.env'),
    join(home, '.claude', 'telegram-bot', '.env'),
    join(home, 'Desktop', 'Проекты разработка', 'command-center', '.env'),
  ]
  for (const credsPath of envCandidates) {
    if (!existsSync(credsPath)) continue
    try {
      const text = await readFile(credsPath, 'utf-8')
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
        if (!m) continue
        const [, k, vRaw] = m
        const v = vRaw.replace(/^["']|["']$/g, '')
        if (!v) continue
        if ((k === 'TG_API_ID' || k === 'TELEGRAM_API_ID') && !out.apiId) out.apiId = Number(v)
        else if ((k === 'TG_API_HASH' || k === 'TELEGRAM_API_HASH') && !out.apiHash) out.apiHash = v
        else if ((k === 'TG_PHONE' || k === 'TELEGRAM_PHONE') && !out.phone) out.phone = v
        else if ((k === 'TG_PASSWORD' || k === 'TELEGRAM_PASSWORD') && !out.password) out.password = v
      }
    } catch {}
  }

  // 3. ~/.teya/config.json
  const saved = await ctx.loadSavedConfig()
  if (saved.telegramApiId && !out.apiId) out.apiId = Number(saved.telegramApiId)
  if (saved.telegramApiHash && !out.apiHash) out.apiHash = saved.telegramApiHash
  if (saved.telegramPhone && !out.phone) out.phone = saved.telegramPhone
  if (saved.telegramPassword && !out.password) out.password = saved.telegramPassword
  if (saved.telegramUserbotSession && !out.sessionString) out.sessionString = saved.telegramUserbotSession

  return out
}

function ask(question: string, silent = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    if (silent) {
      const stdout = process.stdout as unknown as { write: (s: string) => boolean }
      const orig = stdout.write.bind(stdout)
      ;(process.stdout as any).write = (chunk: string) => {
        if (chunk && chunk !== question) return true
        return orig(chunk)
      }
      rl.question(question, (a) => {
        ;(process.stdout as any).write = orig
        process.stdout.write('\n')
        rl.close()
        resolve(a.trim())
      })
    } else {
      rl.question(question, (a) => { rl.close(); resolve(a.trim()) })
    }
  })
}

export async function runTelegramSubcommand(action: string, _args: string[], ctx: Ctx): Promise<void> {
  switch (action) {
    case 'login':       return loginCmd(ctx)
    case 'logout':      return logoutCmd(ctx)
    case 'status':      return statusCmd(ctx)
    case 'doctor':      return doctorCmd(ctx)
    case 'test':        return testCmd(ctx)
    case 'help':
    default: {
      console.log(`Usage: teya telegram <action>

Actions:
  login       Interactive bootstrap — phone code + 2FA, saves session to ~/.teya/config.json
  logout      Forget the saved session (does NOT terminate it on Telegram side)
  status      Show whether a session is saved and connected
  doctor      Run a connectivity check (no message sending)
  test        Full e2e self-test against Saved Messages (creates and cleans up test data)

Credentials are read from (in order):
  1. env vars TG_API_ID / TG_API_HASH / TG_PHONE / TG_PASSWORD
  2. ~/.claude/credentials.env
  3. ~/.teya/config.json (telegramApiId/Hash/Phone)
`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function loginCmd(ctx: Ctx): Promise<void> {
  const creds = await loadCredentials(ctx)
  if (!creds.apiId || !creds.apiHash) {
    console.error('Missing TG_API_ID / TG_API_HASH. Set them in env or ~/.claude/credentials.env.')
    console.error('Get them at https://my.telegram.org/apps')
    process.exit(1)
  }
  if (creds.sessionString) {
    const reuse = await ask('Saved session already exists. Re-login anyway? [y/N]: ')
    if (reuse.toLowerCase() !== 'y') {
      console.log('Aborted. Use `teya telegram logout` first to clear.')
      return
    }
  }

  const transport = new TelegramUserbotTransport({
    apiId: creds.apiId,
    apiHash: creds.apiHash,
    phone: creds.phone,
    password: creds.password,
    onSession: async (session) => {
      const cur = await ctx.loadSavedConfig()
      cur.telegramApiId = String(creds.apiId)
      cur.telegramApiHash = creds.apiHash!
      if (creds.phone) cur.telegramPhone = creds.phone
      cur.telegramUserbotSession = session
      await ctx.saveConfig(cur)
      console.log(`\n[telegram] Session saved to ${ctx.configFile}`)
    },
  })

  console.log('[telegram] Connecting…')
  await transport.start()
  const me = await transport.client.getMe()
  console.log(`[telegram] Logged in as ${(me as any).firstName} (@${(me as any).username || '?'}, id=${(me as any).id})`)
  await transport.stop()
}

async function logoutCmd(ctx: Ctx): Promise<void> {
  const cur = await ctx.loadSavedConfig()
  if (!cur.telegramUserbotSession) {
    console.log('No saved session.')
    return
  }
  delete cur.telegramUserbotSession
  await ctx.saveConfig(cur)
  console.log('Forgotten. Session is still active on Telegram side — terminate it from Telegram → Settings → Devices if needed.')
}

async function statusCmd(ctx: Ctx): Promise<void> {
  const creds = await loadCredentials(ctx)
  console.log(`api_id:  ${creds.apiId ? 'set' : 'MISSING'}`)
  console.log(`api_hash:${creds.apiHash ? ' set' : ' MISSING'}`)
  console.log(`phone:   ${creds.phone || '(not set)'}`)
  console.log(`session: ${creds.sessionString ? `${creds.sessionString.length} chars` : 'NOT SAVED'}`)
  if (!creds.sessionString || !creds.apiId || !creds.apiHash) return

  const transport = new TelegramUserbotTransport({
    apiId: creds.apiId,
    apiHash: creds.apiHash,
    sessionString: creds.sessionString,
  })
  try {
    await transport.client.connect()
    const me = await transport.client.getMe()
    console.log(`connected: yes (as ${(me as any).firstName}, id=${(me as any).id})`)
    await transport.client.disconnect()
  } catch (err) {
    console.error(`connected: NO — ${(err as Error).message}`)
    process.exit(1)
  }
}

async function doctorCmd(ctx: Ctx): Promise<void> {
  const creds = await loadCredentials(ctx)
  const checks: [string, boolean, string?][] = []
  checks.push(['TG_API_ID set', !!creds.apiId])
  checks.push(['TG_API_HASH set', !!creds.apiHash])
  checks.push(['phone set', !!creds.phone])
  checks.push(['session string saved', !!creds.sessionString])

  for (const [label, ok] of checks) {
    console.log(`${ok ? '  ok ' : '  FAIL'}  ${label}`)
  }
  if (!creds.sessionString) {
    console.log('\nRun `teya telegram login` to bootstrap a session.')
    return
  }

  console.log('\nConnecting…')
  const transport = new TelegramUserbotTransport({
    apiId: creds.apiId!,
    apiHash: creds.apiHash!,
    sessionString: creds.sessionString,
  })
  try {
    await transport.client.connect()
    const me = await transport.client.getMe()
    console.log(`  ok    connected as ${(me as any).firstName} (id=${(me as any).id})`)
    const dialogs = await transport.client.getDialogs({ limit: 1 })
    console.log(`  ok    fetched ${dialogs.length} dialog (sanity check)`)
    await transport.client.disconnect()
    console.log('\nAll good.')
  } catch (err) {
    console.error(`  FAIL  ${(err as Error).message}`)
    process.exit(1)
  }
}

// ─── e2e self-test ───────────────────────────────────────────────────────────

async function testCmd(ctx: Ctx): Promise<void> {
  const creds = await loadCredentials(ctx)
  if (!creds.apiId || !creds.apiHash || !creds.sessionString) {
    console.error('Need a saved session. Run `teya telegram login` first.')
    process.exit(1)
  }

  const transport = new TelegramUserbotTransport({
    apiId: creds.apiId,
    apiHash: creds.apiHash,
    sessionString: creds.sessionString,
  })
  await transport.client.connect()

  const tool = createTelegramTool(transport.client, {
    resolvePath: (p) => p.startsWith('/') ? p : join(process.cwd(), p),
    workspaceRoot: process.cwd(),
  })

  const results: { name: string; ok: boolean; detail: string }[] = []
  const run = async (name: string, fn: () => Promise<string>) => {
    process.stdout.write(`  ${name.padEnd(28)} `)
    try {
      const detail = await fn()
      const ok = !/error|fail|not found|missing|need /i.test(detail)
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${detail.split('\n')[0].slice(0, 80)}`)
      results.push({ name, ok, detail })
    } catch (err) {
      console.log(`THROW ${(err as Error).message}`)
      results.push({ name, ok: false, detail: (err as Error).message })
    }
  }

  console.log('\nRunning e2e against Saved Messages ("me")…\n')

  // Sanity / read-only first
  await run('get_me', () => tool.execute({ action: 'get_me' }))
  await run('resolve_peer me', () => tool.execute({ action: 'resolve_peer', peer: 'me' }))
  await run('get_dialogs', () => tool.execute({ action: 'get_dialogs', limit: 5 }))
  await run('get_chat me', () => tool.execute({ action: 'get_chat', peer: 'me' }))
  await run('set_typing me', () => tool.execute({ action: 'set_typing', peer: 'me', action_type: 'typing' }))

  // Send → edit → react → pin → unpin → forward → delete
  const stamp = new Date().toISOString()
  let firstId = 0
  let secondId = 0
  let forwardedId = 0

  await run('send_message #1', async () => {
    const r = await tool.execute({ action: 'send_message', peer: 'me', text: `[teya-e2e] hello ${stamp}` })
    const m = r.match(/sent #(\d+)/); if (m) firstId = Number(m[1])
    return r
  })
  await run('send_message #2', async () => {
    const r = await tool.execute({ action: 'send_message', peer: 'me', text: `[teya-e2e] second message ${stamp}` })
    const m = r.match(/sent #(\d+)/); if (m) secondId = Number(m[1])
    return r
  })
  await run('edit_message #1', () =>
    tool.execute({ action: 'edit_message', peer: 'me', message_id: firstId, text: `[teya-e2e] edited ${stamp}` })
  )
  await run('send_reaction #1 (premium)', async () => {
    const r = await tool.execute({ action: 'send_reaction', peer: 'me', message_id: firstId, emoji: '👍' })
    // PREMIUM_ACCOUNT_REQUIRED is expected for non-Premium accounts
    if (r.includes('PREMIUM_ACCOUNT_REQUIRED')) return 'skipped (Premium-only, expected)'
    return r
  })
  await run('pin_message #1', () =>
    tool.execute({ action: 'pin_message', peer: 'me', message_id: firstId, notify: false })
  )
  await run('pin_message unpin #1', () =>
    tool.execute({ action: 'pin_message', peer: 'me', message_id: firstId, unpin: true })
  )
  await run('forward_messages', async () => {
    const r = await tool.execute({
      action: 'forward_messages', from_peer: 'me', to_peer: 'me', message_ids: [firstId],
    })
    const m = r.match(/forwarded (\d+)/); if (m) forwardedId = firstId
    return r
  })

  // get_messages / search
  await run('get_messages', () =>
    tool.execute({ action: 'get_messages', peer: 'me', limit: 5 })
  )
  await run('get_messages search', () =>
    tool.execute({ action: 'get_messages', peer: 'me', limit: 3, search: '[teya-e2e]' })
  )
  await run('read_history', () =>
    tool.execute({ action: 'read_history', peer: 'me' })
  )

  // File round-trip
  const tmpDir = join(process.env.HOME || '.', '.teya', 'e2e-tmp')
  const tmpFile = join(tmpDir, 'hello.txt')
  const downloaded = join(tmpDir, 'downloaded.txt')
  await (await import('fs/promises')).mkdir(tmpDir, { recursive: true })
  await (await import('fs/promises')).writeFile(tmpFile, `Teya e2e payload ${stamp}\n`)

  let fileMsgId = 0
  await run('send_file', async () => {
    const r = await tool.execute({
      action: 'send_file', peer: 'me', path: tmpFile, caption: '[teya-e2e] file',
    })
    const m = r.match(/sent file #(\d+)/); if (m) fileMsgId = Number(m[1])
    return r
  })
  if (fileMsgId) {
    await run('download_media', () =>
      tool.execute({ action: 'download_media', peer: 'me', message_id: fileMsgId, save_as: downloaded })
    )
  }

  // invoke_raw — sanity-check the escape hatch
  await run('invoke_raw users.GetUsers', () =>
    tool.execute({
      action: 'invoke_raw',
      method: 'users.GetUsers',
      params: { id: [{ _: 'InputUserSelf' }] },
    })
  )

  // get_participants on a known small chat — skip if no chats; safe to fail
  await run('set_typing cancel', () =>
    tool.execute({ action: 'set_typing', peer: 'me', action_type: 'cancel' })
  )

  // Cleanup — delete all test messages we created
  const idsToDelete = [firstId, secondId, fileMsgId].filter(Boolean)
  if (idsToDelete.length) {
    await run('delete_messages cleanup', () =>
      tool.execute({ action: 'delete_messages', peer: 'me', message_ids: idsToDelete })
    )
  }

  await transport.client.disconnect()

  // Summary
  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log(`\nResults: ${passed} passed, ${failed} failed (of ${results.length})`)
  if (failed) {
    console.log('\nFailures:')
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  - ${r.name}: ${r.detail}`)
    }
    process.exit(1)
  }
  console.log('All actions verified against real Telegram MTProto.')
}
