<p align="center"><b>Teya</b></p>

<p align="center"><b>A personal AI assistant that grows with your business.</b></p>

<p align="center">It remembers your clients, tracks your tasks, monitors your metrics, and gets smarter the more you use it. When something needs your attention, it reaches out.</p>

<p align="center"><b>It's yours to shape:</b> Give it a name, a personality, specialized skills, and a team of sub-agents. Talk to it from the terminal, Telegram, or any channel -- same memory everywhere.</p>

<p align="center"><b>It runs on your terms:</b> Use cloud models for power, or run fully offline with local LLMs. Your data never leaves your machine unless you want it to. Sandboxed tools, permission engine, credential isolation.</p>

<p align="center">
  <a href="https://github.com/esporykhin/teya/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
</p>

---

### Personality and intelligence

| Area | Summary |
|------|---------|
| **Memory engine** | **Remembers what matters.** Knowledge graph stores entities, facts, and relations extracted from every conversation. Hybrid search (semantic + keyword) finds relevant context instantly. |
| **Session intelligence** | **Learns from every interaction.** Background process summarizes sessions, extracts topics, and builds a structured understanding of your preferences, projects, and patterns over time. |
| **Identity layer** | **Defines who the assistant is.** Behavior lives in SOUL.md. Operating instructions, workflows, and checklists in AGENTS.md. Each sub-agent has its own personality and expertise. |
| **Autonomous scheduling** | **Works while you sleep.** Standalone daemon executes tasks on cron -- competitor monitoring, report generation, data collection. Retries on failure, catches up on missed windows, full execution history. |
| **Sub-agent delegation** | **The right agent for the right job.** Create specialized agents (`@researcher`, `@analyst`, `@writer`) and mention them directly. Tasks route to the agent with the right skills and context. |

### Infrastructure and security

| Area | Summary |
|------|---------|
| **Privacy** | **Your data stays yours.** Sandboxed workspace -- the agent writes to its own directory, not yours. Run fully offline with Ollama. Zero external calls when you need it. |
| **Permission engine** | **Defaults to safe.** Allow-all, ask-before-acting, rule-based, or deny-all modes. DLP guard blocks data exfiltration. Credentials never reach the model. |
| **Skills** | **Add capabilities through plugins.** Manifest-driven skills with tools and prompt sections. Install from GitHub, URL, or local directory. Sandboxed execution. |
| **Channels** | **One assistant, everywhere.** CLI with image paste and @mentions. Telegram bot. Same memory, same personality, same skills across all channels. |
| **Any LLM** | **Swap models without changing anything.** OpenRouter (100+ models), Ollama (local), or mix them with multi-model routing. Automatic fallback chains. |
| **Observability** | **See everything the agent does.** OTEL-compatible tracing to console, JSON files, or Jaeger/Tempo/Datadog. Every LLM call, tool execution, and delegation tracked with cost and latency. |

---

## Getting started

### CLI

```bash
git clone https://github.com/esporykhin/teya.git
cd teya
pnpm install && pnpm -r build

cd packages/cli && npm link && cd ../..

teya    # interactive setup on first run
```

### Fully local (no cloud, no API keys)

```bash
ollama serve
teya --provider ollama --model qwen3:8b
```

### Cloud (100+ models)

```bash
teya --provider openrouter --api-key YOUR_KEY
```

### Telegram

```bash
teya --transport telegram --telegram-token BOT_TOKEN
```

### Scheduler

```bash
teya scheduler start      # background daemon
teya scheduler install    # auto-start on boot (macOS)
teya scheduler status     # active tasks, execution history
```

---

## Sub-agents

Create specialized agents in `~/.teya/agents/`:

```
~/.teya/agents/researcher/
  SOUL.md       # "You are a web research specialist..."
  AGENTS.md     # workflows, checklists, operating instructions
  config.json   # {"description": "...", "provider": {"type": "ollama", "model": "qwen3:32b"}}
```

Mention them in conversation: `@researcher find the top 5 competitors in this space`

The main agent sees all sub-agents and delegates automatically when the task matches.

---

## Architecture

14 modular packages -- swap any part:

| Package | What it does |
|---------|-------------|
| `core` | Agent loop, types, system prompt, security |
| `providers` | OpenRouter, Ollama, routing, fallback chains |
| `tools` | Built-in tools, MCP client, sandboxed workspace |
| `memory` | Knowledge graph, sessions, assets, intelligence |
| `scheduler` | Task store, cron engine, daemon, multi-agent dispatch |
| `orchestrator` | Sub-agent registry, delegation, isolated execution |
| `skills` | Skill loader, trigger matching, installer |
| `tracing` | OTEL spans, console/JSON/OTLP exporters |
| `eval` | E2E test runner, side-effect scoring |
| `transport-cli` | Terminal UI, image paste, @mentions |
| `transport-telegram` | Telegram bot |
| `context` | Context window management, condensation |
| `data` | YAML schema to SQLite CRUD |
| `cli` | Entry point, config, subcommands |

---

## Development

```bash
pnpm -r build                          # build all
pnpm test                              # tests
teya eval run evals/core-tools.yaml    # e2e evals against live LLM
```

TDD workflow: write eval first, then implement until all checks pass.

---

## License

MIT -- use it however you want, commercially or personally.

Built by [Evgeny Sporykhin](https://github.com/esporykhin).
