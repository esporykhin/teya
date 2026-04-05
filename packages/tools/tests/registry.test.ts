import { describe, it, expect } from 'vitest'
import { createToolRegistry, registerBuiltins } from '../src/index.js'

describe('Tool Registry', () => {
  it('should register and retrieve tools', () => {
    const registry = createToolRegistry()
    registerBuiltins(registry)

    expect(registry.listNames()).toContain('core:think')
    expect(registry.listNames()).toContain('core:web_fetch')
    expect(registry.listNames()).toContain('core:web_search')
    expect(registry.listNames()).toContain('core:plan')
    expect(registry.get('core:think')).toBeDefined()
  })

  it('should execute core:think', async () => {
    const registry = createToolRegistry()
    registerBuiltins(registry)

    const result = await registry.execute({ id: 'test', name: 'core:think', args: { thought: 'Hello' } })
    expect(result.result).toBe('Hello')
    expect(result.error).toBeFalsy()
  })

  it('should return error for unknown tool', async () => {
    const registry = createToolRegistry()
    const result = await registry.execute({ id: 'test', name: 'unknown', args: {} })
    expect(result.error).toBe(true)
    expect(result.result).toContain('not found')
  })
})
