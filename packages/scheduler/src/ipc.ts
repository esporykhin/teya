/**
 * @description Unix domain socket IPC — server (daemon) + client (CLI).
 *
 * Protocol: JSON request/response over Unix socket.
 * One connection per command, no persistent connections.
 */
import { createServer, connect, type Server } from 'net'
import { unlinkSync } from 'fs'
import { join } from 'path'
import type { TaskStore, ExecutionRecord } from './task-store.js'
import type { CronEngine } from './cron-engine.js'
import type { HealthManager } from './health.js'

// ── Protocol ─────────────────────────────────────────────────────────────────

export type IPCRequest =
  | { type: 'status' }
  | { type: 'trigger'; taskId: string }
  | { type: 'cancel'; taskId: string }
  | { type: 'logs'; taskId?: string; limit?: number }
  | { type: 'reload' }

export type IPCResponse =
  | { type: 'status'; data: DaemonStatus }
  | { type: 'trigger'; data: { ok: boolean; message: string } }
  | { type: 'cancel'; data: { ok: boolean } }
  | { type: 'logs'; data: ExecutionRecord[] }
  | { type: 'reload'; data: { agents: number } }
  | { type: 'error'; message: string }

export interface DaemonStatus {
  pid: number
  uptime: number
  activeTasks: string[]
  lastTick?: string
  totalExecutions: number
  agentCount: number
}

// ── Server (runs in daemon) ──────────────────────────────────────────────────

export interface IPCServerDeps {
  store: TaskStore
  engine: CronEngine
  health: HealthManager
  getAgentCount: () => number
  startTime: Date
}

export class IPCServer {
  private server: Server

  constructor(
    private socketPath: string,
    private deps: IPCServerDeps,
  ) {
    // Remove stale socket
    try { unlinkSync(socketPath) } catch {}

    // allowHalfOpen: true is CRITICAL. Without it, when the client calls
    // conn.end() to signal "request complete", Node automatically closes
    // OUR writable side too — before our async handler can compose a
    // response. The server then silently sends an empty body and the CLI
    // reports "IPC not responding". Half-open lets us read the request,
    // process it, and write back on the still-open writable half.
    this.server = createServer({ allowHalfOpen: true }, conn => {
      let data = ''
      // Without an error handler, a broken pipe or write-after-end on this
      // socket bubbles up as an unhandled 'error' event and crashes the
      // entire daemon. Swallow socket errors — the IPC protocol is
      // best-effort, the daemon must keep running cron tasks regardless.
      conn.on('error', () => {})
      conn.on('data', chunk => { data += chunk.toString() })
      conn.on('end', async () => {
        let payload: string
        try {
          const request: IPCRequest = JSON.parse(data)
          const response = await this.handle(request)
          payload = JSON.stringify(response)
        } catch (err) {
          payload = JSON.stringify({ type: 'error', message: (err as Error).message })
        }
        // Try to write the response. If the client tore down the connection
        // (timeout, kill) any of these calls may throw — swallowing them
        // is fine because the protocol is best-effort.
        try {
          if (!conn.destroyed) conn.end(payload)
        } catch {}
      })
    })
    // Defensive: server-level error handler prevents listen-time issues
    // (stale socket, EADDRINUSE) from crashing the process.
    this.server.on('error', err => {
      // eslint-disable-next-line no-console
      console.error(`[ipc] server error: ${(err as Error).message}`)
    })
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.socketPath, () => resolve())
      this.server.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    return new Promise(resolve => {
      this.server.close(() => {
        try { unlinkSync(this.socketPath) } catch {}
        resolve()
      })
    })
  }

  private async handle(req: IPCRequest): Promise<IPCResponse> {
    switch (req.type) {
      case 'status': {
        const engineStatus = this.deps.engine.status()
        const totalExec = this.deps.store.getExecutions(undefined, 1).length > 0
          ? this.deps.store.getExecutions(undefined, 10000).length
          : 0
        return {
          type: 'status',
          data: {
            pid: process.pid,
            uptime: Math.floor((Date.now() - this.deps.startTime.getTime()) / 1000),
            activeTasks: engineStatus.activeTasks,
            lastTick: engineStatus.lastTick,
            totalExecutions: totalExec,
            agentCount: this.deps.getAgentCount(),
          },
        }
      }

      case 'trigger': {
        const task = this.deps.store.get(req.taskId)
        if (!task) return { type: 'trigger', data: { ok: false, message: 'Task not found' } }
        // Queue for immediate execution
        this.deps.store.update(req.taskId, { status: 'pending', dueAt: new Date().toISOString() })
        return { type: 'trigger', data: { ok: true, message: `Task ${req.taskId} queued` } }
      }

      case 'cancel': {
        const ok = this.deps.engine.cancel(req.taskId)
        if (ok) this.deps.store.update(req.taskId, { status: 'cancelled' })
        return { type: 'cancel', data: { ok } }
      }

      case 'logs': {
        const logs = this.deps.store.getExecutions(req.taskId, req.limit || 20)
        return { type: 'logs', data: logs }
      }

      case 'reload': {
        // Caller should reload agent registry externally
        return { type: 'reload', data: { agents: this.deps.getAgentCount() } }
      }

      default:
        return { type: 'error', message: `Unknown request type` }
    }
  }
}

// ── Client (used by CLI) ─────────────────────────────────────────────────────

export class IPCClient {
  constructor(private socketPath: string) {}

  async send(request: IPCRequest): Promise<IPCResponse> {
    return new Promise((resolve, reject) => {
      const conn = connect(this.socketPath)
      let data = ''

      const timeout = setTimeout(() => {
        conn.destroy()
        reject(new Error('IPC timeout'))
      }, 5000)

      conn.on('data', chunk => { data += chunk.toString() })
      conn.on('end', () => {
        clearTimeout(timeout)
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
      conn.on('error', err => {
        clearTimeout(timeout)
        reject(err)
      })
      conn.write(JSON.stringify(request))
      conn.end()
    })
  }

  async isAlive(): Promise<boolean> {
    try {
      const res = await this.send({ type: 'status' })
      return res.type === 'status'
    } catch {
      return false
    }
  }
}

export function createIPCClient(configDir?: string): IPCClient {
  const dir = configDir || join(process.env.HOME || '.', '.teya')
  return new IPCClient(join(dir, 'scheduler.sock'))
}
