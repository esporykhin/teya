/**
 * @description core:assets — unified asset store tool.
 *
 * Actions:
 *   save   — save a file with description
 *   search — find files by keywords, date, source
 *   get    — get asset details by ID
 */
import type { AssetStore } from './assets.js'

export function createAssetTools(store: AssetStore) {
  const assetTool = {
    name: 'core:assets',
    description: `File/document store. Actions:
  save   — save a file with description for later retrieval
  search — find files by keywords, date, or source
  get    — get full details of an asset by ID`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'search', 'get'], description: 'Action to perform' },
        // For save
        file_path: { type: 'string', description: 'Path to file (save)' },
        description: { type: 'string', description: 'File description (save/search)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags (save)' },
        source: { type: 'string', enum: ['user', 'agent'], description: 'Who created (save)' },
        // For search
        query: { type: 'string', description: 'Search keywords (search)' },
        after: { type: 'string', description: 'Files after date, ISO (search)' },
        before: { type: 'string', description: 'Files before date, ISO (search)' },
        // For get
        id: { type: 'number', description: 'Asset ID (get)' },
      },
      required: ['action'],
    },
    source: 'builtin' as const,
    cost: { latency: 'fast' as const, tokenCost: 'low' as const, sideEffects: false, reversible: true, external: false },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const action = args.action as string

      switch (action) {
        case 'save': {
          if (!args.file_path) return 'Need file_path for save.'
          if (!args.description) return 'Need description for save.'
          try {
            const asset = store.save({
              filePath: args.file_path as string,
              description: args.description as string,
              tags: (args.tags as string[]) || [],
              source: (args.source as 'user' | 'agent') || 'agent',
            })
            return `Saved asset #${asset.id}: ${asset.original_name} — "${asset.description}"`
          } catch (err) {
            return `Error: ${(err as Error).message}`
          }
        }

        case 'search': {
          const assets = store.search({
            query: (args.query || args.description) as string | undefined,
            after: args.after as string | undefined,
            before: args.before as string | undefined,
            source: args.source as string | undefined,
          })
          if (assets.length === 0) return 'No files found.'
          return assets.map(a =>
            `#${a.id} [${a.source}] ${a.original_name} — "${a.description}" (${a.created_at})\n  Path: ${a.file_path}`
          ).join('\n\n')
        }

        case 'get': {
          if (!args.id) return 'Need id for get.'
          const asset = store.get(args.id as number)
          if (!asset) return `Asset #${args.id} not found.`
          return JSON.stringify(asset, null, 2)
        }

        default:
          return `Unknown action: ${action}. Use: save, search, get`
      }
    },
  }

  return { assetTool, assetSave: assetTool, assetSearch: assetTool, assetGet: assetTool }
}
