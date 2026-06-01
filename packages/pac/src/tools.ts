/**
 * @description Bridge the BitGN per-trial VM (MiniRuntime / PcmRuntime) into
 * Teya `ToolDefinition`s so that the existing `agentLoop` can drive a trial
 * like any other tool-calling session.
 *
 * Terminal sentinel
 * -----------------
 * `answer` does NOT call the VM.answer RPC from inside the tool — the runner
 * catches the call via a shared `answerBox` and ends the turn by returning a
 * synthetic result. This keeps the runner in control of trial boundaries
 * (cannot call answer twice, can pick the Outcome enum, etc.).
 *
 * Output shape
 * ------------
 * Tool results are short human-readable strings (shell-ish output) rather
 * than JSON blobs. Local models waste tokens on quoted JSON; shell lines are
 * closer to training distribution and easier to reason over.
 */
import type { ToolDefinition } from '@teya/core'
import { OutlineRequest, ReadRequest as MiniRead, ListRequest as MiniList, SearchRequest as MiniSearch, WriteRequest as MiniWrite, DeleteRequest as MiniDel } from '@buf/bitgn_api.bufbuild_es/bitgn/vm/mini_pb.js'
import {
  ReadRequest as PcmRead,
  WriteRequest as PcmWrite,
  DeleteRequest as PcmDelete,
  MkDirRequest,
  MoveRequest,
  ListRequest as PcmList,
  TreeRequest,
  FindRequest,
  FindRequest_Type,
  SearchRequest as PcmSearch,
  ContextRequest,
} from '@buf/bitgn_api.bufbuild_es/bitgn/vm/pcm_pb.js'
import type { MiniClient, PcmClient } from './client.js'

type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<string>
}

const INSTANT = {
  latency: 'fast' as const,
  tokenCost: 'low' as const,
  sideEffects: false,
  reversible: true,
  external: true,
}

const MUTATING = {
  latency: 'fast' as const,
  tokenCost: 'low' as const,
  sideEffects: true,
  reversible: false,
  external: true,
}

/** Written by `vm:answer` tool; read by the runner to end the trial. */
export interface AnswerBox {
  message?: string
  refs?: string[]
  outcome?: 'OK' | 'DENIED_SECURITY' | 'NONE_CLARIFICATION' | 'NONE_UNSUPPORTED' | 'ERR_INTERNAL'
  submitted: boolean
}

/** Sentinel returned from vm:answer tool so the runner can abort cleanly. */
export const ANSWER_SENTINEL = '__PAC_ANSWER_SUBMITTED__'

// ─── Mini (sandbox) ──────────────────────────────────────────────────────────

export function buildMiniTools(vm: MiniClient, box: AnswerBox): RegisteredTool[] {
  const outline: RegisteredTool = {
    name: 'vm:outline',
    description: 'Non-recursive tree view of a folder or single file. Use "/" for workspace root. Returns folders + file headings.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Folder or file path. "/" = root.' } },
      required: ['path'],
    },
    source: 'plugin',
    cost: INSTANT,
    execute: async (args) => {
      const res = await vm.outline(new OutlineRequest({ path: String(args.path ?? '/') }))
      const lines: string[] = [`path: ${res.path}`]
      for (const f of res.folders) lines.push(`[dir] ${f}`)
      for (const f of res.files) {
        const heads = f.headers.length ? ` — ${f.headers.join(' | ')}` : ''
        lines.push(`[file] ${f.path}${heads}`)
      }
      return lines.join('\n') || '(empty)'
    },
  }

  const list: RegisteredTool = {
    name: 'vm:list',
    description: 'List immediate children (folders + files) of a folder.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    source: 'plugin',
    cost: INSTANT,
    execute: async (args) => {
      const res = await vm.list(new MiniList({ path: String(args.path ?? '/') }))
      const lines: string[] = []
      for (const f of res.folders) lines.push(`[dir] ${f}`)
      for (const f of res.files) lines.push(`[file] ${f}`)
      return lines.join('\n') || '(empty)'
    },
  }

  const read: RegisteredTool = {
    name: 'vm:read',
    description: 'Read full contents of a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    source: 'plugin',
    cost: INSTANT,
    execute: async (args) => {
      const res = await vm.read(new MiniRead({ path: String(args.path) }))
      return res.content
    },
  }

  const search: RegisteredTool = {
    name: 'vm:search',
    description: 'Regex search across the workspace. POSIX pattern, not glob. Returns up to `count` snippets.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'POSIX regex' },
        count: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
        path: { type: 'string', description: 'Search root (currently ignored by runtime).', default: '/' },
      },
      required: ['pattern'],
    },
    source: 'plugin',
    cost: INSTANT,
    execute: async (args) => {
      const count = Math.max(1, Math.min(10, Number(args.count ?? 5)))
      const res = await vm.search(new MiniSearch({
        path: String(args.path ?? '/'),
        pattern: String(args.pattern),
        count,
      }))
      if (!res.snippets.length) return '(no matches)'
      return res.snippets.map(s => `${s.file}:${s.line}: ${s.match}`).join('\n')
    },
  }

  const write: RegisteredTool = {
    name: 'vm:write',
    description: 'Write full file content (overwrite). Creates parent folders as needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    source: 'plugin',
    cost: MUTATING,
    execute: async (args) => {
      await vm.write(new MiniWrite({ path: String(args.path), content: String(args.content) }))
      return `written ${String(args.content).length} chars to ${args.path}`
    },
  }

  const del: RegisteredTool = {
    name: 'vm:delete',
    description: 'Delete a file or folder.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    source: 'plugin',
    cost: MUTATING,
    execute: async (args) => {
      await vm.delete(new MiniDel({ path: String(args.path) }))
      return `deleted ${args.path}`
    },
  }

  const answer = buildAnswerTool(box, /*hasOutcome*/ false)

  return [outline, list, read, search, write, del, answer]
}

// ─── PCM ─────────────────────────────────────────────────────────────────────

export function buildPcmTools(vm: PcmClient, box: AnswerBox): RegisteredTool[] {
  const tree: RegisteredTool = {
    name: 'vm:tree',
    description: 'Recursive tree listing. Use empty root for workspace root. `level` matches `tree -L`.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', default: '' },
        level: { type: 'integer', minimum: 0, default: 2 },
      },
    },
    source: 'plugin',
    cost: INSTANT,
    execute: async (args) => {
      const res = await vm.tree(new TreeRequest({
        root: String(args.root ?? ''),
        level: Number(args.level ?? 2),
      }))
      if (!res.root) return '(empty)'
      const lines: string[] = []
      const walk = (node: { name: string; isDir: boolean; children: any[] }, depth: number) => {
        const prefix = '  '.repeat(depth)
        lines.push(`${prefix}${node.isDir ? '[dir] ' : '[file] '}${node.name}`)
        for (const child of node.children) walk(child, depth + 1)
      }
      walk(res.root, 0)
      return lines.join('\n')
    },
  }

  const list: RegisteredTool = {
    name: 'vm:list',
    description: 'List immediate children of a directory.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Directory path' } },
      required: ['name'],
    },
    source: 'plugin',
    cost: INSTANT,
    execute: async (args) => {
      const res = await vm.list(new PcmList({ name: String(args.name) }))
      if (!res.entries.length) return '(empty)'
      return res.entries.map(e => `${e.isDir ? '[dir] ' : '[file] '}${e.name}`).join('\n')
    },
  }

  const read: RegisteredTool = {
    name: 'vm:read',
    description: 'Read file contents. Optional line slicing (1-based inclusive). `number: true` adds line numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        number: { type: 'boolean', default: false },
        start_line: { type: 'integer', default: 0 },
        end_line: { type: 'integer', default: 0 },
      },
      required: ['path'],
    },
    source: 'plugin',
    cost: INSTANT,
    execute: async (args) => {
      const res = await vm.read(new PcmRead({
        path: String(args.path),
        number: Boolean(args.number ?? false),
        startLine: Number(args.start_line ?? 0),
        endLine: Number(args.end_line ?? 0),
      }))
      return res.content
    },
  }

  const write: RegisteredTool = {
    name: 'vm:write',
    description: 'Write file contents. Omit start_line/end_line for whole-file overwrite; provide them for ranged replace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        start_line: { type: 'integer', default: 0 },
        end_line: { type: 'integer', default: 0 },
      },
      required: ['path', 'content'],
    },
    source: 'plugin',
    cost: MUTATING,
    execute: async (args) => {
      await vm.write(new PcmWrite({
        path: String(args.path),
        content: String(args.content),
        startLine: Number(args.start_line ?? 0),
        endLine: Number(args.end_line ?? 0),
      }))
      return `written ${String(args.content).length} chars to ${args.path}`
    },
  }

  const del: RegisteredTool = {
    name: 'vm:delete',
    description: 'Delete a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    source: 'plugin',
    cost: MUTATING,
    execute: async (args) => {
      await vm.delete(new PcmDelete({ path: String(args.path) }))
      return `deleted ${args.path}`
    },
  }

  const mkdir: RegisteredTool = {
    name: 'vm:mkdir',
    description: 'Create a directory (idempotent).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    source: 'plugin',
    cost: MUTATING,
    execute: async (args) => {
      await vm.mkDir(new MkDirRequest({ path: String(args.path) }))
      return `mkdir ${args.path}`
    },
  }

  const move: RegisteredTool = {
    name: 'vm:move',
    description: 'Rename / move a file or folder.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
      },
      required: ['from', 'to'],
    },
    source: 'plugin',
    cost: MUTATING,
    execute: async (args) => {
      await vm.move(new MoveRequest({ fromName: String(args.from), toName: String(args.to) }))
      return `moved ${args.from} -> ${args.to}`
    },
  }

  const find: RegisteredTool = {
    name: 'vm:find',
    description: 'Find paths by name under `root`. Type filter: all|files|dirs.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', default: '' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['all', 'files', 'dirs'], default: 'all' },
        limit: { type: 'integer', default: 20 },
      },
      required: ['name'],
    },
    source: 'plugin',
    cost: INSTANT,
    execute: async (args) => {
      const typeStr = String(args.type ?? 'all')
      const typeEnum =
        typeStr === 'files' ? FindRequest_Type.FILES :
        typeStr === 'dirs' ? FindRequest_Type.DIRS :
        FindRequest_Type.ALL
      const res = await vm.find(new FindRequest({
        root: String(args.root ?? ''),
        name: String(args.name),
        type: typeEnum,
        limit: Number(args.limit ?? 20),
      }))
      return res.items.length ? res.items.join('\n') : '(no matches)'
    },
  }

  const search: RegisteredTool = {
    name: 'vm:search',
    description: 'Regex content search (ripgrep-style). Returns path:line: text matches.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', default: '' },
        pattern: { type: 'string' },
        limit: { type: 'integer', default: 20 },
      },
      required: ['pattern'],
    },
    source: 'plugin',
    cost: INSTANT,
    execute: async (args) => {
      const res = await vm.search(new PcmSearch({
        root: String(args.root ?? ''),
        pattern: String(args.pattern),
        limit: Number(args.limit ?? 20),
      }))
      if (!res.matches.length) return '(no matches)'
      return res.matches.map(m => `${m.path}:${m.line}: ${m.lineText}`).join('\n')
    },
  }

  const context: RegisteredTool = {
    name: 'vm:context',
    description: 'Current trial wall-clock context (RFC3339 time + unix seconds).',
    parameters: { type: 'object', properties: {} },
    source: 'plugin',
    cost: INSTANT,
    execute: async () => {
      const res = await vm.context(new ContextRequest({}))
      return `time=${res.time} unix=${res.unixTime.toString()}`
    },
  }

  const answer = buildAnswerTool(box, /*hasOutcome*/ true)

  return [tree, list, read, write, del, mkdir, move, find, search, context, answer]
}

// ─── Answer sentinel ────────────────────────────────────────────────────────

function buildAnswerTool(box: AnswerBox, hasOutcome: boolean): RegisteredTool {
  const properties: Record<string, unknown> = {
    message: { type: 'string', description: 'Final answer to the task instruction' },
    refs: { type: 'array', items: { type: 'string' }, description: 'File paths that ground the answer' },
  }
  const required = ['message']
  if (hasOutcome) {
    properties.outcome = {
      type: 'string',
      enum: ['OK', 'DENIED_SECURITY', 'NONE_CLARIFICATION', 'NONE_UNSUPPORTED', 'ERR_INTERNAL'],
      default: 'OK',
      description: 'Resolution state. Use OK for successful answers, DENIED_SECURITY for policy refusals, NONE_* when task is unresolvable, ERR_INTERNAL on internal failure.',
    }
  }
  return {
    name: 'vm:answer',
    description: hasOutcome
      ? 'Submit the final answer and end the trial. Pass outcome=OK unless the task is blocked or unresolvable.'
      : 'Submit the final answer and end the trial. Always call this last.',
    parameters: { type: 'object', properties, required },
    source: 'plugin',
    cost: INSTANT,
    execute: async (args) => {
      box.message = String(args.message ?? '')
      // Scorer expects workspace-relative refs without a leading slash
      // (e.g. "AGENTS.MD" not "/AGENTS.MD"). Normalise here so the prompt
      // doesn't have to nag the model about slashes.
      box.refs = Array.isArray(args.refs)
        ? (args.refs as unknown[]).map(r => String(r).replace(/^\/+/, ''))
        : []
      if (hasOutcome) {
        const raw = String(args.outcome ?? 'OK').toUpperCase()
        box.outcome =
          raw === 'OK' || raw === 'DENIED_SECURITY' || raw === 'NONE_CLARIFICATION' ||
          raw === 'NONE_UNSUPPORTED' || raw === 'ERR_INTERNAL'
            ? (raw as AnswerBox['outcome'])
            : 'OK'
      }
      box.submitted = true
      return ANSWER_SENTINEL
    },
  }
}
