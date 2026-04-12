/**
 * @description Tests for the @teya/runtime process registry.
 *
 * Covers the contract that other packages depend on:
 *  - register() writes the file and starts heartbeat
 *  - list() / get() return alive entries, prune dead ones
 *  - dead PIDs are filtered out
 *  - stale heartbeats are treated as dead even if PID exists
 *  - stop() returns false for unknown id
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import * as runtime from '../src/index.js'

const TEST_PREFIX = `test-${process.pid}-${Date.now()}`
const cleanup: string[] = []

function uniqueId(suffix: string): string {
  const id = `${TEST_PREFIX}-${suffix}`
  cleanup.push(id)
  return id
}

describe('@teya/runtime registry', () => {
  afterEach(() => {
    // Drop in-process state (heartbeat timers, exit listeners) AND the
    // registry file. Critical for vitest workers which would otherwise
    // accumulate >10 'exit' listeners and crash with channel closed.
    for (const id of cleanup.splice(0)) {
      runtime.unregister(id)
      const file = join(runtime.getRunDir(), `${id}.json`)
      try { rmSync(file) } catch {}
    }
  })

  it('register writes the file with PID and metadata', () => {
    const id = uniqueId('register')
    runtime.register(id, 'Test process', { heartbeatMs: 0, installSignalHandlers: false })

    const file = join(runtime.getRunDir(), `${id}.json`)
    expect(existsSync(file)).toBe(true)

    const entry = JSON.parse(readFileSync(file, 'utf-8'))
    expect(entry.id).toBe(id)
    expect(entry.pid).toBe(process.pid)
    expect(entry.description).toBe('Test process')
    expect(entry.lastHeartbeat).toBeTruthy()
  })

  it('list returns registered alive processes', () => {
    const id = uniqueId('list')
    runtime.register(id, 'List test', { heartbeatMs: 0, installSignalHandlers: false })

    const procs = runtime.list()
    const found = procs.find(p => p.id === id)
    expect(found).toBeDefined()
    expect(found?.pid).toBe(process.pid)
  })

  it('get returns one entry', () => {
    const id = uniqueId('get')
    runtime.register(id, 'Get test', { heartbeatMs: 0, installSignalHandlers: false })
    const entry = runtime.get(id)
    expect(entry).not.toBeNull()
    expect(entry?.id).toBe(id)
  })

  it('list prunes entries whose PID no longer exists', () => {
    const id = uniqueId('dead-pid')
    const fakePid = 999999
    const file = join(runtime.getRunDir(), `${id}.json`)
    writeFileSync(file, JSON.stringify({
      id,
      pid: fakePid,
      startedAt: new Date().toISOString(),
      args: ['/fake'],
      description: 'fake',
      logFile: '/tmp/fake.log',
      lastHeartbeat: new Date().toISOString(),
    }))

    const procs = runtime.list()
    expect(procs.find(p => p.id === id)).toBeUndefined()
    expect(existsSync(file)).toBe(false)
  })

  it('list prunes entries with stale heartbeats even if PID exists', () => {
    const id = uniqueId('stale-heartbeat')
    const file = join(runtime.getRunDir(), `${id}.json`)
    const oldTime = new Date(Date.now() - 5 * 60_000).toISOString()
    writeFileSync(file, JSON.stringify({
      id,
      pid: process.pid,
      startedAt: oldTime,
      args: ['/fake'],
      description: 'stale',
      logFile: '/tmp/stale.log',
      lastHeartbeat: oldTime,
    }))

    const entry = runtime.get(id)
    expect(entry).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('register starts a heartbeat that updates the file', async () => {
    const id = uniqueId('heartbeat')
    runtime.register(id, 'HB test', { heartbeatMs: 100, installSignalHandlers: false })

    const file = join(runtime.getRunDir(), `${id}.json`)
    const initial = JSON.parse(readFileSync(file, 'utf-8'))

    await new Promise(r => setTimeout(r, 250))

    const updated = JSON.parse(readFileSync(file, 'utf-8'))
    expect(new Date(updated.lastHeartbeat).getTime()).toBeGreaterThan(new Date(initial.lastHeartbeat).getTime())
  })

  it('stop returns false for unknown id', async () => {
    const result = await runtime.stop('definitely-not-registered-' + Date.now())
    expect(result).toBe(false)
  })
})
