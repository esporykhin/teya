/**
 * @description Parse YAML eval suite files
 */
import { readFile } from 'fs/promises'
import type { EvalSuite, EvalCase } from './types.js'

export async function loadEvalSuite(filePath: string): Promise<EvalSuite> {
  const content = await readFile(filePath, 'utf-8')
  return parseEvalYaml(content)
}

function parseEvalYaml(content: string): EvalSuite {
  // Simple parser for our specific format
  const suite: EvalSuite = { name: 'unnamed', cases: [] }
  let currentCase: Partial<EvalCase> | null = null
  let currentExpected: Record<string, unknown> = {}
  let inExpected = false

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const indent = line.length - line.trimStart().length
    const kv = parseKeyValue(trimmed)
    if (!kv) continue

    if (indent === 0) {
      if (kv.key === 'suite' || kv.key === 'name') suite.name = kv.value
    }

    if (trimmed === '- input:' || (indent <= 4 && kv.key === 'input' && trimmed.startsWith('- '))) {
      // New case
      if (currentCase?.input) {
        currentCase.expected = currentExpected as EvalCase['expected']
        suite.cases.push(currentCase as EvalCase)
      }
      currentCase = { input: kv.value || '' }
      currentExpected = {}
      inExpected = false
    } else if (indent >= 4 && currentCase) {
      if (kv.key === 'input') {
        currentCase.input = kv.value
        inExpected = false
      } else if (kv.key === 'name') {
        currentCase.name = kv.value
        inExpected = false
      } else if (kv.key === 'expect' || kv.key === 'expected') {
        inExpected = true
      } else if (inExpected || indent >= 6) {
        // Expected properties
        const val = kv.value
        if (kv.key === 'response_contains') currentExpected.response_contains = val
        else if (kv.key === 'tool_called') currentExpected.tool_called = val
        else if (kv.key === 'no_tool_called') currentExpected.no_tool_called = val
        else if (kv.key === 'max_cost') currentExpected.max_cost = parseFloat(val)
        else if (kv.key === 'max_turns') currentExpected.max_turns = parseInt(val)
      }
    }
  }

  // Don't forget last case
  if (currentCase?.input) {
    currentCase.expected = currentExpected as EvalCase['expected']
    suite.cases.push(currentCase as EvalCase)
  }

  return suite
}

function parseKeyValue(line: string): { key: string; value: string } | null {
  const clean = line.replace(/^-\s*/, '')
  const colonIdx = clean.indexOf(':')
  if (colonIdx < 0) return null
  const key = clean.slice(0, colonIdx).trim()
  const value = clean.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
  return { key, value }
}
