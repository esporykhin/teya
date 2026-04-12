/**
 * @description Cron engine — timezone-aware matching, catch-up for missed windows.
 *
 * Uses Intl.DateTimeFormat for timezone conversion (no dependencies).
 * Supports: minute hour day month weekday (standard 5-field cron).
 * Fields: number, *, * /N (step), comma lists (1,3,5), ranges (1-5).
 */
import type { TaskStore, Task } from './task-store.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface DateParts {
  minute: number
  hour: number
  day: number
  month: number
  weekday: number // 0 = Sunday
}

export interface CronEngineExecutor {
  execute(task: Task, signal: AbortSignal): Promise<void>
}

// ── CronEngine ───────────────────────────────────────────────────────────────

export class CronEngine {
  private running = new Map<string, AbortController>()
  private maxConcurrent: number
  private lastTickTime?: string

  constructor(
    private store: TaskStore,
    private executor: CronEngineExecutor,
    options?: { maxConcurrent?: number },
  ) {
    this.maxConcurrent = options?.maxConcurrent ?? 3
  }

  /** Main tick — check for due tasks and dispatch */
  async tick(): Promise<void> {
    this.lastTickTime = new Date().toISOString()

    // Cron tasks
    const cronTasks = this.store.listCronTasks()
    const now = new Date()

    for (const task of cronTasks) {
      if (task.status === 'in_progress') continue
      if (this.running.has(task.id)) continue
      if (this.running.size >= this.maxConcurrent) break

      // Manual trigger override: when something (e.g. core:schedule(trigger))
      // sets status=pending and due_at in the past on a cron task, run it
      // immediately regardless of the cron expression. Without this, manually
      // triggered cron tasks sit in pending forever — the cron clock won't
      // re-fire them until their next scheduled slot.
      const isManualTrigger =
        task.status === 'pending' && task.dueAt && new Date(task.dueAt).getTime() <= now.getTime()
      if (isManualTrigger) {
        this.dispatch(task)
        continue
      }

      if (isCronDueInTimezone(task.cron!, task.timezone, task.lastRunAt, now)) {
        this.dispatch(task)
      }
    }

    // One-off due tasks (cron IS NULL)
    const dueOneOff = this.store.getDueOneOffTasks()
    for (const task of dueOneOff) {
      if (this.running.has(task.id)) continue
      if (this.running.size >= this.maxConcurrent) break
      this.dispatch(task)
    }
  }

  /** Catch-up: execute missed cron windows since lastAlive */
  async catchUp(lastAlive: Date): Promise<string[]> {
    const cronTasks = this.store.listCronTasks()
    const now = new Date()
    const executed: string[] = []

    for (const task of cronTasks) {
      if (!task.cron) continue
      const reference = task.lastRunAt && new Date(task.lastRunAt) > lastAlive
        ? new Date(task.lastRunAt)
        : lastAlive

      if (hasMissedWindow(task.cron, task.timezone, reference, now)) {
        this.dispatch(task)
        executed.push(task.id)
      }
    }

    return executed
  }

  private dispatch(task: Task): void {
    const abort = new AbortController()
    this.running.set(task.id, abort)

    // Set timeout
    const timeout = setTimeout(() => abort.abort(), task.timeoutMs)

    this.executor.execute(task, abort.signal)
      .finally(() => {
        clearTimeout(timeout)
        this.running.delete(task.id)
      })
  }

  /** Cancel a running task */
  cancel(taskId: string): boolean {
    const abort = this.running.get(taskId)
    if (abort) {
      abort.abort()
      this.running.delete(taskId)
      return true
    }
    return false
  }

  status(): { activeTasks: string[]; lastTick?: string } {
    return {
      activeTasks: [...this.running.keys()],
      lastTick: this.lastTickTime,
    }
  }
}

// ── Pure functions ───────────────────────────────────────────────────────────

/** Get time parts in a specific timezone */
export function getTimeInTimezone(date: Date, tz: string): DateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
    hour12: false,
  })

  const parts = formatter.formatToParts(date)
  const get = (type: string) => {
    const p = parts.find(p => p.type === type)
    return p ? parseInt(p.value, 10) : 0
  }

  const weekdayStr = parts.find(p => p.type === 'weekday')?.value || 'Sun'
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }

  return {
    minute: get('minute'),
    hour: get('hour'),
    day: get('day'),
    month: get('month'),
    weekday: weekdayMap[weekdayStr] ?? 0,
  }
}

/** Check if cron expression matches current time in task's timezone */
export function isCronDueInTimezone(
  cron: string,
  timezone: string,
  lastRunAt: string | undefined,
  now: Date,
): boolean {
  const parts = getTimeInTimezone(now, timezone)
  if (!matchCron(cron, parts)) return false

  // Dedup: don't run twice in the same minute
  if (lastRunAt) {
    const lastParts = getTimeInTimezone(new Date(lastRunAt), timezone)
    if (lastParts.minute === parts.minute &&
        lastParts.hour === parts.hour &&
        lastParts.day === parts.day &&
        lastParts.month === parts.month) {
      return false
    }
  }

  return true
}

/** Check if a cron window was missed between `from` and `to` */
export function hasMissedWindow(cron: string, timezone: string, from: Date, to: Date): boolean {
  // Walk forward minute-by-minute, capped at 1440 (24h)
  const maxIterations = 1440
  const startMs = from.getTime()
  const endMs = to.getTime()

  // Skip if less than 2 minutes apart
  if (endMs - startMs < 120_000) return false

  for (let i = 1; i <= maxIterations; i++) {
    const checkTime = new Date(startMs + i * 60_000)
    if (checkTime.getTime() >= endMs) break

    const parts = getTimeInTimezone(checkTime, timezone)
    if (matchCron(cron, parts)) return true
  }

  return false
}

/** Match a 5-field cron expression against date parts */
export function matchCron(cron: string, parts: DateParts): boolean {
  const fields = cron.trim().split(/\s+/)
  if (fields.length < 5) return false

  return (
    matchField(fields[0], parts.minute) &&
    matchField(fields[1], parts.hour) &&
    matchField(fields[2], parts.day) &&
    matchField(fields[3], parts.month) &&
    matchField(fields[4], parts.weekday)
  )
}

/** Match a single cron field against a value */
export function matchField(pattern: string, value: number): boolean {
  if (pattern === '*') return true

  // Step: */5
  if (pattern.startsWith('*/')) {
    const step = parseInt(pattern.slice(2), 10)
    return step > 0 && value % step === 0
  }

  // List: 1,3,5
  if (pattern.includes(',')) {
    return pattern.split(',').some(p => matchField(p.trim(), value))
  }

  // Range: 1-5
  if (pattern.includes('-')) {
    const [start, end] = pattern.split('-').map(Number)
    return value >= start && value <= end
  }

  // Exact
  return parseInt(pattern, 10) === value
}
