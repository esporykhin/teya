/**
 * @description Registers all builtin tools into a ToolRegistry.
 *
 * Tools are grouped by domain (compound tools with action parameter):
 *   core:files    — read, write, list, find
 *   core:web      — fetch, search, request
 *   core:exec     — shell command execution
 *   core:browser  — navigate, read, click, type, screenshot
 *   core:email    — send, accounts
 *
 * Standalone tools:
 *   core:think, core:ask_user, core:plan, core:respond, core:tool_search
 *   core:spawn_task, core:check_task (background commands)
 *   core:delegate (sub-agent delegation, registered separately)
 *   core:memory, core:assets (registered from @teya/memory)
 *   core:tasks, core:schedule (registered from @teya/scheduler)
 */
import type { ToolRegistry } from '../registry.js'
import { thinkTool } from './think.js'
import { askUserTool } from './ask-user.js'
import { planTool } from './plan.js'
import { filesTool } from './files.js'
import { webTool } from './web.js'
import { execTool } from './exec.js'
import { spawnTaskTool, checkTaskTool } from './spawn-task.js'
import { toolSearchTool } from './tool-search.js'
import {
  browserNavigateTool,
  browserReadTool,
  browserClickTool,
  browserTypeTool,
  browserScreenshotTool,
  closeBrowser,
} from './browser.js'
import { emailSendTool, emailListAccountsTool } from './email.js'
import { respondTool } from './respond.js'
import { toolResultGetTool } from './tool-result-get.js'

// Re-exports
export { thinkTool } from './think.js'
export { askUserTool } from './ask-user.js'
export { planTool } from './plan.js'
export { filesTool, filesTool as readFileTool, filesTool as writeFileTool, filesTool as listDirTool, filesTool as findFilesTool } from './files.js'
export { webTool } from './web.js'
export { execTool } from './exec.js'
export { spawnTaskTool, checkTaskTool } from './spawn-task.js'
export { toolSearchTool } from './tool-search.js'
export {
  browserNavigateTool,
  browserReadTool,
  browserClickTool,
  browserTypeTool,
  browserScreenshotTool,
  closeBrowser,
} from './browser.js'
export { emailSendTool, emailListAccountsTool } from './email.js'
export { respondTool } from './respond.js'
export { toolResultGetTool } from './tool-result-get.js'
export { createToolLoadTool } from './tool-load.js'

export function registerBuiltins(registry: ToolRegistry): void {
  // Standalone tools
  registry.register(thinkTool)
  registry.register(askUserTool)
  registry.register(planTool)
  registry.register(respondTool)
  registry.register(toolResultGetTool)  // retrieves truncated tool results from session store

  // Compound domain tools
  registry.register(filesTool)       // core:files (read, write, list, find)
  registry.register(webTool)         // core:web (fetch, search, request)
  registry.register(execTool)        // core:exec (stays as single — it's one action)

  // Background tasks
  registry.register(spawnTaskTool)
  registry.register(checkTaskTool)

  // Browser (TODO: compound into core:browser)
  registry.register(browserNavigateTool)
  registry.register(browserReadTool)
  registry.register(browserClickTool)
  registry.register(browserTypeTool)
  registry.register(browserScreenshotTool)

  // Email (TODO: compound into core:email)
  registry.register(emailSendTool)
  registry.register(emailListAccountsTool)

  // Tool search — needs registry closure
  registry.register({
    ...toolSearchTool,
    execute: async (args: Record<string, unknown>) => {
      const query = (args.query as string).toLowerCase()
      const allTools = registry.list()
      const matches = allTools.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.description.toLowerCase().includes(query),
      )
      if (matches.length === 0)
        return `No tools found matching "${args.query}". Total tools available: ${allTools.length}`
      return matches.map((t) => `${t.name} — ${t.description}`).join('\n')
    },
  })
}
