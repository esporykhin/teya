/**
 * @description Regression test for the allowHalfOpen IPC bug.
 *
 * Background: net.createServer() defaults to allowHalfOpen: false. When
 * the client called conn.end() to signal "request complete", Node closed
 * BOTH halves of the connection — including the server's writable side —
 * before our async handler could compose a response. The server then
 * silently sent an empty body and the CLI reported "IPC not responding".
 *
 * The fix is { allowHalfOpen: true } in createServer. This test would
 * have caught the bug instantly: it sends a request, waits for the
 * response, and asserts the response is non-empty and parses as the
 * expected protocol shape.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { connect } from 'net'
import { IPCServer, type IPCResponse } from '../src/ipc.js'

interface MockEngine {
  status(): { activeTasks: string[]; lastTick?: string }
  cancel(_taskId: string): boolean
}

interface MockStore {
  get(_id: string): unknown
  update(_id: string, _u: unknown): void
  getExecutions(_id: string | undefined, _limit: number): unknown[]
}

function makeMockDeps(socketPath: string) {
  const engine: MockEngine = {
    status: () => ({ activeTasks: [], lastTick: '2026-04-12T08:00:00.000Z' }),
    cancel: () => true,
  }
  const store: MockStore = {
    get: () => null,
    update: () => {},
    getExecutions: () => [],
  }
  return {
    socketPath,
    deps: {
      store: store as any,
      engine: engine as any,
      getAgentCount: () => 0,
      startTime: new Date(),
    },
  }
}

function sendRequest(socketPath: string, request: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = connect(socketPath)
    let data = ''
    const timeout = setTimeout(() => {
      conn.destroy()
      reject(new Error('client timeout'))
    }, 3000)
    conn.on('data', chunk => { data += chunk.toString() })
    conn.on('end', () => { clearTimeout(timeout); resolve(data) })
    conn.on('error', err => { clearTimeout(timeout); reject(err) })
    conn.write(JSON.stringify(request))
    conn.end()
  })
}

describe('IPCServer', () => {
  let tmpDir: string
  let server: IPCServer

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'teya-ipc-test-'))
  })

  afterEach(async () => {
    if (server) await server.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns a non-empty response for a status request (allowHalfOpen regression)', async () => {
    const { socketPath, deps } = makeMockDeps(join(tmpDir, 'sched.sock'))
    server = new IPCServer(socketPath, deps)
    await server.start()

    const raw = await sendRequest(socketPath, { type: 'status' })

    // Without allowHalfOpen: true the server's writable side is auto-closed
    // before the handler can write, and the client receives empty body.
    expect(raw.length).toBeGreaterThan(0)

    const parsed = JSON.parse(raw) as IPCResponse
    expect(parsed.type).toBe('status')
    if (parsed.type === 'status') {
      expect(parsed.data.activeTasks).toEqual([])
      expect(parsed.data.lastTick).toBe('2026-04-12T08:00:00.000Z')
    }
  })

  it('survives many status requests without crashing the server', async () => {
    const { socketPath, deps } = makeMockDeps(join(tmpDir, 'sched.sock'))
    server = new IPCServer(socketPath, deps)
    await server.start()

    // Hammer the server — before the fix, every request triggered an
    // unhandled 'error' event from the write-after-end socket, which
    // would crash the entire daemon process.
    for (let i = 0; i < 10; i++) {
      const raw = await sendRequest(socketPath, { type: 'status' })
      expect(raw.length).toBeGreaterThan(0)
    }
  })

  it('returns a parseable error for an unknown request type', async () => {
    const { socketPath, deps } = makeMockDeps(join(tmpDir, 'sched.sock'))
    server = new IPCServer(socketPath, deps)
    await server.start()

    const raw = await sendRequest(socketPath, { type: 'nope' as never })
    const parsed = JSON.parse(raw) as IPCResponse
    expect(parsed.type).toBe('error')
  })
})
