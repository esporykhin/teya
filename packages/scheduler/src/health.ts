/**
 * @description PID file + heartbeat management for daemon lifecycle.
 */
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

export class HealthManager {
  private pidPath: string
  private heartbeatPath: string
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(private configDir: string) {
    this.pidPath = join(configDir, 'scheduler.pid')
    this.heartbeatPath = join(configDir, 'scheduler.hb')
  }

  writePid(): void {
    mkdirSync(this.configDir, { recursive: true })
    writeFileSync(this.pidPath, String(process.pid))
  }

  startHeartbeat(intervalMs = 10_000): void {
    this.writeHeartbeat()
    this.heartbeatTimer = setInterval(() => this.writeHeartbeat(), intervalMs)
  }

  private writeHeartbeat(): void {
    writeFileSync(this.heartbeatPath, new Date().toISOString())
  }

  readLastHeartbeat(): Date | null {
    try {
      const ts = readFileSync(this.heartbeatPath, 'utf-8').trim()
      return new Date(ts)
    } catch {
      return null
    }
  }

  cleanup(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    try { unlinkSync(this.pidPath) } catch {}
    try { unlinkSync(this.heartbeatPath) } catch {}
  }

  /** Check if daemon is alive (callable from CLI, static) */
  static isAlive(configDir: string): { alive: boolean; pid?: number } {
    try {
      const pid = parseInt(readFileSync(join(configDir, 'scheduler.pid'), 'utf-8').trim(), 10)
      process.kill(pid, 0) // signal 0 = just check if process exists
      return { alive: true, pid }
    } catch {
      return { alive: false }
    }
  }
}
