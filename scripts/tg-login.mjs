#!/usr/bin/env node
/**
 * Standalone Telegram userbot login — no readline, takes code as argv[1].
 * Usage:
 *   Step 1: node scripts/tg-login.mjs           → sends code request, prints phone_code_hash
 *   Step 2: node scripts/tg-login.mjs <CODE>     → signs in with the code, saves session
 */
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const HOME = process.env.HOME || '.'
const CONFIG = join(HOME, '.teya', 'config.json')
const HASH_FILE = join(HOME, '.teya', '_tg_phone_code_hash.tmp')

// Load creds
function loadCreds() {
  const envFiles = [
    join(HOME, '.claude', 'credentials.env'),
    join(HOME, 'Desktop', 'Проекты разработка', 'command-center', '.env'),
  ]
  const out = {}
  for (const f of envFiles) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/)
      if (!m) continue
      const [, k, v] = m
      if (k === 'TG_API_ID' && !out.apiId) out.apiId = Number(v)
      if (k === 'TG_API_HASH' && !out.apiHash) out.apiHash = v
      if (k === 'TG_PHONE' && !out.phone) out.phone = v
    }
  }
  // config.json
  if (existsSync(CONFIG)) {
    try {
      const c = JSON.parse(readFileSync(CONFIG, 'utf-8'))
      if (c.telegramApiId && !out.apiId) out.apiId = Number(c.telegramApiId)
      if (c.telegramApiHash && !out.apiHash) out.apiHash = c.telegramApiHash
      if (c.telegramPhone && !out.phone) out.phone = c.telegramPhone
      if (c.telegramUserbotSession) out.session = c.telegramUserbotSession
    } catch {}
  }
  return out
}

const creds = loadCreds()
if (!creds.apiId || !creds.apiHash || !creds.phone) {
  console.error('Missing TG_API_ID / TG_API_HASH / TG_PHONE')
  process.exit(1)
}

const code = process.argv[2]
const client = new TelegramClient(
  new StringSession(creds.session || ''),
  creds.apiId,
  creds.apiHash,
  {
    connectionRetries: 5,
    deviceModel: 'MacBookPro18,1',
    systemVersion: 'macOS 15.1',
    appVersion: 'Teya 0.1.0',
    langCode: 'en',
    systemLangCode: 'en',
  }
)

await client.connect()

if (!code) {
  // Step 1: send code request
  console.log(`Sending code to ${creds.phone}...`)
  const result = await client.invoke(new Api.auth.SendCode({
    phoneNumber: creds.phone,
    apiId: creds.apiId,
    apiHash: creds.apiHash,
    settings: new Api.CodeSettings({}),
  }))
  const hash = result.phoneCodeHash
  writeFileSync(HASH_FILE, hash, 'utf-8')
  console.log(`Code sent! Hash saved.`)
  console.log(`\nNow run: node scripts/tg-login.mjs <CODE>`)
  console.log(`(enter the code you received in Telegram)`)
  await client.disconnect()
} else {
  // Step 2: sign in with code
  if (!existsSync(HASH_FILE)) {
    console.error('No phone_code_hash found. Run without code first.')
    process.exit(1)
  }
  const hash = readFileSync(HASH_FILE, 'utf-8').trim()
  console.log(`Signing in with code ${code}...`)
  try {
    await client.invoke(new Api.auth.SignIn({
      phoneNumber: creds.phone,
      phoneCodeHash: hash,
      phoneCode: code,
    }))
  } catch (err) {
    if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      console.error('2FA password required. Pass it as second argument:')
      console.error('  node scripts/tg-login.mjs <CODE> <PASSWORD>')
      const password = process.argv[3]
      if (!password) {
        await client.disconnect()
        process.exit(1)
      }
      const srpResult = await client.invoke(new Api.account.GetPassword())
      const { computeCheck } = await import('telegram/Password.js')
      const srpCheck = await computeCheck(srpResult, password)
      await client.invoke(new Api.auth.CheckPassword({ password: srpCheck }))
    } else {
      throw err
    }
  }

  // Save session
  const session = client.session.save()
  const config = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf-8')) : {}
  config.telegramApiId = String(creds.apiId)
  config.telegramApiHash = creds.apiHash
  config.telegramPhone = creds.phone
  config.telegramUserbotSession = session
  writeFileSync(CONFIG, JSON.stringify(config, null, 2), 'utf-8')

  const me = await client.getMe()
  console.log(`Logged in as ${me.firstName} (@${me.username || '?'}, id=${me.id})`)
  console.log(`Session saved to ${CONFIG}`)

  // Cleanup
  try { const { unlinkSync } = await import('fs'); unlinkSync(HASH_FILE) } catch {}
  await client.disconnect()
}
