/**
 * @description core:browser — browse web pages with persistent session and anti-detection
 * @exports browserNavigateTool, browserReadTool, browserClickTool, browserTypeTool, browserScreenshotTool, closeBrowser
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { join } from 'path'
import { mkdirSync } from 'fs'
import type { ToolDefinition } from '@teya/core'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

const BROWSER_DIR = join(process.env.HOME || '.', '.teya', 'browser')

let context: BrowserContext | null = null
let page: Page | null = null

async function getPage(): Promise<Page> {
  if (page && !page.isClosed()) return page

  mkdirSync(BROWSER_DIR, { recursive: true })

  // Launch with persistent context — cookies/localStorage survive
  context = await chromium.launchPersistentContext(BROWSER_DIR, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    // Anti-detection
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  })

  // Remove webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })

  page = context.pages()[0] || (await context.newPage())
  return page
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close()
    context = null
    page = null
  }
}

export const browserNavigateTool: RegisteredTool = {
  name: 'core:browser_navigate',
  description:
    'Open a URL in a real browser with login sessions and cookies. Use ONLY when you need to: log into sites, fill forms, interact with JavaScript-heavy pages, or bypass bot detection. For simple page reading use core:web_fetch. For APIs use core:http_request.',
  parameters: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'URL to navigate to' },
      wait_for: {
        type: 'string',
        description:
          'Wait strategy: "load", "domcontentloaded", "networkidle". Default: "load"',
      },
    },
    required: ['url'],
  },
  source: 'builtin' as const,
  cost: {
    latency: 'slow' as const,
    tokenCost: 'high' as const,
    sideEffects: false,
    reversible: true,
    external: true,
  },
  timeout: 30000,
  execute: async (args: Record<string, unknown>) => {
    try {
      const p = await getPage()
      const waitUntil = (args.wait_for as string) || 'load'
      await p.goto(args.url as string, {
        waitUntil: waitUntil as 'load' | 'domcontentloaded' | 'networkidle',
        timeout: 25000,
      })

      const title = await p.title()
      // Get readable text content
      const text = await p.evaluate(() => {
        // Remove scripts, styles, nav, footer, ads
        const remove = document.querySelectorAll(
          'script, style, nav, footer, header, [role="navigation"], [role="banner"], .ad, .ads, .advertisement',
        )
        remove.forEach((el) => el.remove())
        return (document.body as HTMLElement)?.innerText?.slice(0, 8000) || ''
      })

      const url = p.url()
      return `Page: ${title}\nURL: ${url}\n\n${text}`
    } catch (err: unknown) {
      return `Browser error: ${(err as Error).message}`
    }
  },
}

export const browserReadTool: RegisteredTool = {
  name: 'core:browser_read',
  description:
    'Read the current page content. Returns title, URL, and text content of the current page.',
  parameters: {
    type: 'object' as const,
    properties: {
      selector: {
        type: 'string',
        description: 'Optional CSS selector to read specific element',
      },
    },
  },
  source: 'builtin' as const,
  cost: {
    latency: 'fast' as const,
    tokenCost: 'high' as const,
    sideEffects: false,
    reversible: true,
    external: false,
  },
  execute: async (args: Record<string, unknown>) => {
    try {
      const p = await getPage()
      const title = await p.title()
      const url = p.url()

      let text: string
      if (args.selector) {
        const el = p.locator(args.selector as string)
        text = await el.innerText({ timeout: 5000 }).catch(() => 'Element not found')
      } else {
        text = await p.evaluate(
          () => (document.body as HTMLElement)?.innerText?.slice(0, 8000) || '',
        )
      }

      return `Page: ${title}\nURL: ${url}\n\n${text}`
    } catch (err: unknown) {
      return `Browser error: ${(err as Error).message}`
    }
  },
}

export const browserClickTool: RegisteredTool = {
  name: 'core:browser_click',
  description: 'Click an element on the page by CSS selector or text content.',
  parameters: {
    type: 'object' as const,
    properties: {
      selector: {
        type: 'string',
        description:
          'CSS selector or text to click. For text: use "text=Click me"',
      },
    },
    required: ['selector'],
  },
  source: 'builtin' as const,
  cost: {
    latency: 'fast' as const,
    tokenCost: 'none' as const,
    sideEffects: true,
    reversible: false,
    external: true,
  },
  execute: async (args: Record<string, unknown>) => {
    try {
      const p = await getPage()
      await p.click(args.selector as string, { timeout: 10000 })
      await p.waitForLoadState('load', { timeout: 10000 }).catch(() => {})
      const title = await p.title()
      const url = p.url()
      return `Clicked. Now on: ${title} (${url})`
    } catch (err: unknown) {
      return `Click error: ${(err as Error).message}`
    }
  },
}

export const browserTypeTool: RegisteredTool = {
  name: 'core:browser_type',
  description: 'Type text into an input field on the page.',
  parameters: {
    type: 'object' as const,
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector of the input field',
      },
      text: { type: 'string', description: 'Text to type' },
      press_enter: {
        type: 'boolean',
        description: 'Press Enter after typing. Default: false',
      },
    },
    required: ['selector', 'text'],
  },
  source: 'builtin' as const,
  cost: {
    latency: 'fast' as const,
    tokenCost: 'none' as const,
    sideEffects: true,
    reversible: false,
    external: true,
  },
  execute: async (args: Record<string, unknown>) => {
    try {
      const p = await getPage()
      await p.fill(args.selector as string, args.text as string, { timeout: 10000 })
      if (args.press_enter) {
        await p.press(args.selector as string, 'Enter')
        await p.waitForLoadState('load', { timeout: 10000 }).catch(() => {})
      }
      return `Typed "${args.text}" into ${args.selector}${args.press_enter ? ' and pressed Enter' : ''}`
    } catch (err: unknown) {
      return `Type error: ${(err as Error).message}`
    }
  },
}

export const browserScreenshotTool: RegisteredTool = {
  name: 'core:browser_screenshot',
  description:
    'Take a screenshot of the current page. Saves to ~/.teya/assets/ and returns the file path.',
  parameters: {
    type: 'object' as const,
    properties: {
      full_page: {
        type: 'boolean',
        description:
          'Capture full page or just viewport. Default: false (viewport only)',
      },
    },
  },
  source: 'builtin' as const,
  cost: {
    latency: 'fast' as const,
    tokenCost: 'none' as const,
    sideEffects: true,
    reversible: true,
    external: false,
  },
  execute: async (args: Record<string, unknown>) => {
    try {
      const p = await getPage()
      const assetsDir = join(process.env.HOME || '.', '.teya', 'assets')
      mkdirSync(assetsDir, { recursive: true })
      const fileName = `screenshot-${Date.now()}.png`
      const filePath = join(assetsDir, fileName)

      await p.screenshot({
        path: filePath,
        fullPage: (args.full_page as boolean) || false,
      })

      return `Screenshot saved: ${filePath}`
    } catch (err: unknown) {
      return `Screenshot error: ${(err as Error).message}`
    }
  },
}
