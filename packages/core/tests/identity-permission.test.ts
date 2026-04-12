/**
 * @description Tests for the identity-aware permission fence.
 *
 * This is the critical security boundary that protects the host machine
 * from a stranger writing to the bot. If any of these tests turn red,
 * a guest can run arbitrary code on the owner's box.
 */
import { describe, it, expect } from 'vitest'
import { PermissionEngine, GUEST_SAFE_TOOLS } from '../src/security.js'
import { runWithIdentity, makeIdentityContext } from '../src/identity.js'
import type { ToolCall } from '../src/types.js'

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'test', name, args }
}

describe('PermissionEngine — identity fence', () => {
  const engine = new PermissionEngine({ mode: 'allow-all' })

  describe('owner identity (full trust)', () => {
    const owner = makeIdentityContext({ kind: 'owner', label: 'admin' })

    it('allows core:exec', () => {
      runWithIdentity(owner, () => {
        expect(engine.check(call('core:exec'))).toBe('allow')
      })
    })

    it('allows core:files', () => {
      runWithIdentity(owner, () => {
        expect(engine.check(call('core:files'))).toBe('allow')
      })
    })

    it('allows core:tasks', () => {
      runWithIdentity(owner, () => {
        expect(engine.check(call('core:tasks'))).toBe('allow')
      })
    })

    it('allows core:browser_navigate', () => {
      runWithIdentity(owner, () => {
        expect(engine.check(call('core:browser_navigate'))).toBe('allow')
      })
    })

    it('allows core:email_send', () => {
      runWithIdentity(owner, () => {
        expect(engine.check(call('core:email_send'))).toBe('allow')
      })
    })

    it('allows random MCP tools', () => {
      runWithIdentity(owner, () => {
        expect(engine.check(call('mcp:filesystem:write_file'))).toBe('allow')
      })
    })
  })

  describe('guest identity (sandboxed)', () => {
    const guest = makeIdentityContext({
      kind: 'guest',
      userId: '123456',
      transport: 'telegram',
    })

    it('DENIES core:exec — host shell access', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:exec'))).toBe('deny')
      })
    })

    it('DENIES core:tasks — would let guest schedule background work', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:tasks'))).toBe('deny')
      })
    })

    it('DENIES core:schedule', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:schedule'))).toBe('deny')
      })
    })

    it('DENIES core:browser_navigate — could hijack owner sessions', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:browser_navigate'))).toBe('deny')
      })
    })

    it('DENIES core:email_send — would mail as owner', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:email_send'))).toBe('deny')
      })
    })

    it('DENIES core:delegate — sub-agents inherit owner permissions', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:delegate'))).toBe('deny')
      })
    })

    it('DENIES core:telegram (userbot client)', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:telegram'))).toBe('deny')
      })
    })

    it('DENIES random MCP tools (unknown attack surface)', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('mcp:filesystem:write_file'))).toBe('deny')
      })
    })

    it('ALLOWS core:memory (sandboxed to guest scope by registry)', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:memory'))).toBe('allow')
      })
    })

    it('ALLOWS core:think', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:think'))).toBe('allow')
      })
    })

    it('ALLOWS core:web_search', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:web_search'))).toBe('allow')
      })
    })

    it('ALLOWS core:respond', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:respond'))).toBe('allow')
      })
    })

    it('ALLOWS core:files (sandbox-bound by resolveWorkspacePath)', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:files'))).toBe('allow')
      })
    })

    it('ALLOWS core:assets (per-scope store)', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:assets'))).toBe('allow')
      })
    })

    it('ALLOWS core:data (per-scope SQLite)', () => {
      runWithIdentity(guest, () => {
        expect(engine.check(call('core:data'))).toBe('allow')
      })
    })
  })

  describe('GUEST_SAFE_TOOLS list', () => {
    it('does not include any host-execution tools', () => {
      const dangerous = ['core:exec', 'core:shell', 'core:tasks', 'core:schedule', 'core:browser_navigate', 'core:email_send', 'core:delegate', 'core:telegram']
      for (const t of dangerous) {
        expect(GUEST_SAFE_TOOLS).not.toContain(t)
      }
    })

    it('includes sandbox-bound storage tools', () => {
      // These are safe because their leaf modules are identity-aware:
      // resolveWorkspacePath blocks escape, registries route per-scope.
      expect(GUEST_SAFE_TOOLS).toContain('core:memory')
      expect(GUEST_SAFE_TOOLS).toContain('core:files')
      expect(GUEST_SAFE_TOOLS).toContain('core:assets')
      expect(GUEST_SAFE_TOOLS).toContain('core:data')
      expect(GUEST_SAFE_TOOLS).toContain('core:web_search')
    })
  })

  describe('no identity (legacy / library callers)', () => {
    it('falls back to mode (allow-all) when no identity is set', () => {
      // No runWithIdentity wrapper — this is library or legacy code paths.
      expect(engine.check(call('core:exec'))).toBe('allow')
    })
  })
})
