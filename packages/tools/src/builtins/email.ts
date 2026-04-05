/**
 * @description core:email_send, core:email_accounts — email tools with configurable SMTP
 */
import type { ToolDefinition } from '@teya/core'
import { createTransport } from 'nodemailer'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

interface EmailAccount {
  name: string
  email: string
  smtp: {
    host: string
    port: number
    secure?: boolean
    user: string
    pass: string
  }
}

function loadEmailConfig(): EmailAccount[] {
  const configPath = join(process.env.HOME || '.', '.teya', 'email.json')
  if (!existsSync(configPath)) return []
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8'))
    return Array.isArray(data) ? data : [data]
  } catch {
    return []
  }
}

const CONFIG_HINT =
  'Create ~/.teya/email.json:\n' +
  '[\n' +
  '  {\n' +
  '    "name": "work",\n' +
  '    "email": "you@example.com",\n' +
  '    "smtp": {\n' +
  '      "host": "smtp.gmail.com",\n' +
  '      "port": 587,\n' +
  '      "secure": false,\n' +
  '      "user": "you@example.com",\n' +
  '      "pass": "your-app-password"\n' +
  '    }\n' +
  '  }\n' +
  ']'

export const emailSendTool: RegisteredTool = {
  name: 'core:email_send',
  description:
    'Send an email via SMTP. Configure accounts in ~/.teya/email.json first. Supports plain text and HTML.',
  parameters: {
    type: 'object' as const,
    properties: {
      to: {
        type: 'string',
        description: 'Recipient email address(es), comma-separated',
      },
      subject: {
        type: 'string',
        description: 'Email subject',
      },
      body: {
        type: 'string',
        description: 'Email body (plain text)',
      },
      html: {
        type: 'string',
        description: 'Email body as HTML (optional, overrides plain text body)',
      },
      from_account: {
        type: 'string',
        description:
          'Account name from ~/.teya/email.json. Uses first account if not specified.',
      },
      cc: {
        type: 'string',
        description: 'CC recipients, comma-separated',
      },
      bcc: {
        type: 'string',
        description: 'BCC recipients, comma-separated',
      },
    },
    required: ['to', 'subject', 'body'],
  },
  source: 'builtin' as const,
  cost: {
    latency: 'slow' as const,
    tokenCost: 'none' as const,
    sideEffects: true,
    reversible: false,
    external: true,
  },
  execute: async (args: Record<string, unknown>) => {
    const accounts = loadEmailConfig()
    if (accounts.length === 0) {
      return `No email accounts configured. ${CONFIG_HINT}`
    }

    const accountName = args.from_account as string | undefined
    const account = accountName
      ? accounts.find((a) => a.name === accountName)
      : accounts[0]

    if (!account) {
      return `Account "${accountName}" not found. Available: ${accounts.map((a) => a.name).join(', ')}`
    }

    try {
      const transport = createTransport({
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure ?? account.smtp.port === 465,
        auth: {
          user: account.smtp.user,
          pass: account.smtp.pass,
        },
      })

      const result = await transport.sendMail({
        from: `${account.name} <${account.email}>`,
        to: args.to as string,
        cc: args.cc as string | undefined,
        bcc: args.bcc as string | undefined,
        subject: args.subject as string,
        text: args.body as string,
        html: args.html as string | undefined,
      })

      return `Email sent to ${args.to}. Message ID: ${result.messageId}`
    } catch (err: unknown) {
      return `Email send error: ${(err as Error).message}`
    }
  },
}

export const emailListAccountsTool: RegisteredTool = {
  name: 'core:email_accounts',
  description:
    'List configured email accounts from ~/.teya/email.json.',
  parameters: {
    type: 'object' as const,
    properties: {},
  },
  source: 'builtin' as const,
  cost: {
    latency: 'instant' as const,
    tokenCost: 'none' as const,
    sideEffects: false,
    reversible: true,
    external: false,
  },
  execute: async () => {
    const accounts = loadEmailConfig()
    if (accounts.length === 0) {
      return `No email accounts configured. ${CONFIG_HINT}`
    }
    return accounts
      .map(
        (a) =>
          `- ${a.name}: ${a.email} (SMTP: ${a.smtp.host}:${a.smtp.port})`,
      )
      .join('\n')
  },
}
