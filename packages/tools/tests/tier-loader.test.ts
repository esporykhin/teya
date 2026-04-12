/**
 * @description Tests for the tiered tool catalog (full / activated / stub).
 *
 * Pins the contract that:
 *  - Always-on tools (think, plan, memory, etc) NEVER stub
 *  - Tools become full after markUsed() / activate()
 *  - All other tools are stubbed with placeholder schema + STUB marker
 *  - Total tools count is preserved
 */
import { describe, it, expect } from 'vitest'
import { DynamicToolLoader } from '../src/dynamic-loader.js'
import type { ToolDefinition, ProviderCapabilities } from '@teya/core'

const caps: ProviderCapabilities = {
  toolCalling: true,
  parallelToolCalls: true,
  streaming: true,
  vision: false,
  jsonMode: true,
  maxContextTokens: 200000,
  maxOutputTokens: 8192,
  costPerInputToken: 0,
  costPerOutputToken: 0,
}

function makeTool(name: string, description = 'desc'): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    source: 'builtin',
    cost: { latency: 'instant', tokenCost: 'low', sideEffects: false, reversible: true, external: false },
  }
}

describe('DynamicToolLoader — tier system', () => {
  const tools = [
    makeTool('core:think', 'Internal scratchpad for reasoning'),
    makeTool('core:plan', 'Create a plan'),
    makeTool('core:respond', 'Send response'),
    makeTool('core:ask_user', 'Ask user'),
    makeTool('core:tool_search', 'Search tools'),
    makeTool('core:tool_load', 'Load tool schemas'),
    makeTool('core:tool_result_get', 'Get truncated result'),
    makeTool('core:memory', 'Knowledge graph'),
    makeTool('core:exec', 'Run shell commands. With many lines of detailed description that should be hidden in stub mode.'),
    makeTool('core:files', 'File ops'),
    makeTool('core:web', 'Web fetch and search'),
    makeTool('core:browser_navigate', 'Navigate browser'),
    makeTool('core:tasks', 'Task management'),
    makeTool('core:assets', 'Asset store'),
    makeTool('core:data', 'Data SQLite'),
  ]

  it('always-on tools never get stubbed', () => {
    const loader = new DynamicToolLoader()
    loader.setTools(tools)
    const result = loader.selectTools('hi', caps)
    const alwaysOn = ['core:think', 'core:plan', 'core:respond', 'core:ask_user', 'core:tool_search', 'core:tool_load', 'core:tool_result_get', 'core:memory']
    for (const name of alwaysOn) {
      const t = result.find(t => t.name === name)
      expect(t).toBeDefined()
      expect(t!.description).not.toContain('[STUB —')
    }
  })

  it('non-always-on tools start as stubs', () => {
    const loader = new DynamicToolLoader()
    loader.setTools(tools)
    const result = loader.selectTools('hi', caps)
    const exec = result.find(t => t.name === 'core:exec')!
    expect(exec.description).toContain('[STUB —')
    expect(exec.description).toContain('core:tool_load')
    // Stub schema should be the placeholder
    expect((exec.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(true)
  })

  it('markUsed promotes a tool to full schema', () => {
    const loader = new DynamicToolLoader()
    loader.setTools(tools)
    loader.markUsed('core:exec')
    const result = loader.selectTools('hi', caps)
    const exec = result.find(t => t.name === 'core:exec')!
    expect(exec.description).not.toContain('[STUB —')
    expect((exec.parameters as { properties?: object }).properties).toBeDefined()
  })

  it('activate() promotes multiple tools at once and reports unknowns', () => {
    const loader = new DynamicToolLoader()
    loader.setTools(tools)
    const { activated, unknown } = loader.activate(['core:browser_navigate', 'core:nope', 'core:tasks'])
    expect(activated).toContain('core:browser_navigate')
    expect(activated).toContain('core:tasks')
    expect(unknown).toContain('core:nope')

    const result = loader.selectTools('hi', caps)
    expect(result.find(t => t.name === 'core:browser_navigate')!.description).not.toContain('[STUB —')
    expect(result.find(t => t.name === 'core:tasks')!.description).not.toContain('[STUB —')
    // Other non-always-on still stubbed
    expect(result.find(t => t.name === 'core:web')!.description).toContain('[STUB —')
  })

  it('resetSession clears activated tier', () => {
    const loader = new DynamicToolLoader()
    loader.setTools(tools)
    loader.markUsed('core:exec')
    loader.resetSession()
    const result = loader.selectTools('hi', caps)
    expect(result.find(t => t.name === 'core:exec')!.description).toContain('[STUB —')
  })

  it('selectTools preserves total count (no tools dropped)', () => {
    const loader = new DynamicToolLoader()
    loader.setTools(tools)
    expect(loader.selectTools('hi', caps).length).toBe(tools.length)
  })

  it('stub description is much shorter than full', () => {
    const loader = new DynamicToolLoader()
    loader.setTools(tools)
    const stub = loader.selectTools('hi', caps).find(t => t.name === 'core:exec')!
    expect(stub.description.length).toBeLessThan(200)
  })

  it('selectToolsWithMode returns metadata for each tool', () => {
    const loader = new DynamicToolLoader()
    loader.setTools(tools)
    loader.markUsed('core:exec')
    const result = loader.selectToolsWithMode('hi', caps)
    expect(result.find(r => r.tool.name === 'core:think')!.mode).toBe('full')
    expect(result.find(r => r.tool.name === 'core:exec')!.mode).toBe('full')
    expect(result.find(r => r.tool.name === 'core:web')!.mode).toBe('stub')
  })
})
