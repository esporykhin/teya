/**
 * @description Agent registry — loads sub-agent configs from ~/.teya/agents/
 */
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

export interface AgentDef {
  id: string
  description: string
  dir: string
  config: {
    provider?: { type: string; model: string; apiKey?: string }
    personality?: string
    instructions?: string
  }
}

export class AgentRegistry {
  private agents: Map<string, AgentDef> = new Map()

  async loadFromDirectory(baseDir: string): Promise<void> {
    try {
      const entries = await readdir(baseDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const agentDir = join(baseDir, entry.name)

        let config: any = {}
        try {
          const raw = await readFile(join(agentDir, 'config.json'), 'utf-8')
          config = JSON.parse(raw)
        } catch {
          // No config — use defaults
        }

        let description = config.description || ''
        if (!description) {
          try {
            const soul = await readFile(join(agentDir, 'SOUL.md'), 'utf-8')
            description = soul.split('\n').find((l: string) => l.trim() && !l.startsWith('#'))?.trim() || entry.name
          } catch {
            description = entry.name
          }
        }

        this.agents.set(entry.name, {
          id: entry.name,
          description,
          dir: agentDir,
          config,
        })
      }
    } catch {
      // Directory doesn't exist — ok
    }
  }

  register(agent: AgentDef): void {
    this.agents.set(agent.id, agent)
  }

  get(id: string): AgentDef | undefined {
    return this.agents.get(id)
  }

  list(): AgentDef[] {
    return [...this.agents.values()]
  }

  search(query: string): AgentDef[] {
    const lower = query.toLowerCase()
    return this.list().filter(a =>
      a.id.toLowerCase().includes(lower) ||
      a.description.toLowerCase().includes(lower)
    )
  }
}
