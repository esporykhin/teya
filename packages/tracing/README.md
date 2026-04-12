# @teya/tracing

Глубокий трейсинг агентного цикла Teya: спаны, экспортёры, query API и enrichment.

## Зачем

Понять, **где утекают токены, время и деньги** в работе агента — на уровне отдельной сессии, отдельного turn-а, отдельного LLM-вызова, отдельного tool call. Без этого нельзя осмысленно улучшать ни компоненты (system prompt, tool catalog, condenser), ни сам цикл (когда срабатывает fallback, сколько кэширует провайдер, что обрезается в компакции).

Модуль строит OTEL-совместимые спаны из потока `AgentEvent`, эмитимого `@teya/core/agent-loop`, и сохраняет их в jsonl с двумя представлениями: дневной агрегат и per-session файл.

## Архитектурные принципы

1. **Однонаправленный поток данных.** `agent-loop` и провайдеры эмитят `AgentEvent`. Tracer **только потребляет** события и превращает их в спаны. Tracer не лезет в HTTP, файловую систему (кроме экспортёров), провайдеры или сессии.
2. **Расширение через типы, не через хуки.** Чтобы добавить новое поле — расширяешь `AgentEvent` в `@teya/core/types.ts`, эмитишь его из source, обрабатываешь в `tracer.processEvent`. Никаких изменений в потребителях.
3. **Декаплинг enrichment-а.** OpenRouter возвращает реальную цену с задержкой 30–60s через отдельный API. Эту задержку обслуживает отдельный класс `GenerationEnricher`, который не блокирует agent loop и шлёт результат обратно в трейсер как синтетические события.
4. **Read-only query layer.** `query.ts` — чистые функции над jsonl. Никакого state. Используется и `teya trace` CLI, и (потенциально) внешними дашбордами через прямой импорт.
5. **Per-session изоляция.** Sub-агенты получают свой child tracer (`spawnChild`), который шарит exporter и traceId, но имеет независимый span state. Иерархия `parent → delegate.<id> → sub-agent.turn → ...` строится в реальном времени.

## Поток данных

```
                                                     ┌──────────────────────────┐
                                                     │   ~/.teya/traces/        │
                                                     │   ├── 2026-04-12.jsonl   │ ← daily aggregate
                                                     │   └── sessions/          │
                                                     │       └── <id>.jsonl     │ ← per-session
                                                     └──────────────────────────┘
                                                                ▲
                                                                │
                                                          [exporters]
                                                                │
                                                                │
@teya/core ──── AgentEvent ────▶  AgentTracer ──── Span ────▶  exporter
agent-loop                            │
                                      │ context (sessionId, agentId, transport, userMessage)
                                      │
                                      ▼
                                  TraceContext
                                      ▲
                                      │ setContext()
                                      │
                              @teya/cli (per-message)


@teya/providers ─── transport, generationId, retries ──┐
   openrouter                                          │
                                                       ▼
                                            response.transport
                                            response.generationId
                                                       │
                                                       │
                                              agent-loop yields
                                              thinking_end {transport, ...}
                                                       │
                                                       ▼
                                                   AgentTracer
                                                       │
                                                       │
                                          enricher.enqueue(generationId)
                                                       │
                                                       │ background polling
                                                       ▼
                                          provider.getGenerationDetails()
                                                       │
                                                       │ (~3-30s later)
                                                       ▼
                                          tracer.processEvent({
                                            type: 'generation_details',
                                            actualCostUsd, ...
                                          })
                                                       │
                                                       ▼
                                          llm.generation_details span


@teya/orchestrator ─── delegateTask() ──┐
                                        │
                                        ▼
                          parent.beginDelegateSpan(agentId, task)
                                        │
                                        ▼
                          parent.spawnChild(delegateSpanId)
                                        │
                                        ▼
                          child tracer processes sub-agent events
                          (independent state, shared exporter+traceId)
                                        │
                                        ▼
                          parent.finishDelegateSpan(span, status, totals)
```

## Карта спанов

```
agent.session                          # ленивый, закрывается на /exit или /clear
│   attributes:
│     session.id, agent.id, transport
│     session.turns, session.llm_calls, session.tool_calls
│     session.input_tokens, session.output_tokens, session.cached_tokens
│     session.cost.usd, session.fallback_count, session.error_count
│     session.reason: 'exit' | 'reset' | 'crash'
│
├── provider.fallback                  # standalone, при срабатывании fallback
│     fallback.from, fallback.to, fallback.error
│
├── agent.turn.N                       # один user message → response
│   │   turn.number, turn.input_tokens, turn.output_tokens
│   │   turn.cached_tokens, turn.cost.usd_estimated
│   │   turn.tools_invoked, turn.llm_calls
│   │   user.message  (первые 500 chars)
│   │
│   ├── llm.generate                   # каждый отдельный LLM call
│   │     gen_ai.request.model / response.model / response.provider
│   │     gen_ai.request.system_tokens / messages_tokens / tools_tokens
│   │     gen_ai.request.messages_count / tools_count
│   │     gen_ai.usage.input_tokens / output_tokens / total_tokens
│   │     gen_ai.usage.cached_input_tokens / reasoning_tokens
│   │     gen_ai.response.finish_reason  ('stop' | 'tool_calls' | 'length')
│   │     gen_ai.response.id              (для последующего лукапа)
│   │     gen_ai.cost.usd_estimated       (по локальным ценам)
│   │     gen_ai.latency_ms               (полное wall-time generate())
│   │     http.latency_ms                 (HTTP round-trip)
│   │     http.ttfb_ms                    (time to first byte)
│   │     http.request_bytes / response_bytes / status_code / retry_count
│   │     llm.call_number_in_turn
│   │     context.compaction_parent       (если перед этим был компакт)
│   │     context.compaction_saved_tokens
│   │
│   ├── llm.generation_details         # асинхронно через GenerationEnricher
│   │     gen_ai.cost.usd_actual          (реальная цена с провайдера)
│   │     gen_ai.usage.cached_input_tokens_actual
│   │     gen_ai.provider.name            ('Alibaba', 'Together', ...)
│   │     gen_ai.provider.latency_ms
│   │
│   ├── tool.<name>                    # каждый tool call
│   │     tool.name, tool.call_id
│   │     tool.args        (full, до 5000 chars)
│   │     tool.result_preview / tool.result_size / tool.result_tokens
│   │     tool.latency_ms
│   │     tool.error
│   │
│   ├── tool.<name>.denied             # permission denied
│   ├── tool.<name>.not_found          # tool not registered
│   │
│   ├── context.compact                # компакция контекста
│   │     context.before_tokens / after_tokens / delta_tokens
│   │     context.phase: 'trim_tool_results' | 'drop_thinking'
│   │                  | 'summarize' | 'hard_truncate'
│   │
│   ├── plan.proposed                  # core:plan tool fired
│   ├── agent.ask_user                 # core:ask_user tool fired
│   │
│   └── delegate.<sub-agent>           # суб-агент через core:delegate
│       │   delegate.agent_id, delegate.task, delegate.status
│       │   delegate.turns, delegate.cost.usd
│       │
│       └── agent.turn.M               # вложенные spans от child tracer
│           ├── llm.generate
│           ├── tool.<name>
│           └── ...
```

## Файлы модуля

| Файл | Назначение |
|------|-----------|
| `src/span.ts` | Span / SpanEvent типы и хелперы `createSpan` / `endSpan` |
| `src/tracer.ts` | `AgentTracer` — главный класс. State machine над AgentEvent. |
| `src/exporters.ts` | `consoleExporter`, `jsonExporter` (daily), `sessionFileExporter` (per-session), `otlpExporter`, `compositeExporter` |
| `src/enricher.ts` | `GenerationEnricher` — фоновый polling провайдера для real cost |
| `src/query.ts` | Read-only API: `loadSessionSpans`, `listTracedSessions`, `aggregateCost`, `findAnomalies`, `diffSessions` |
| `src/index.ts` | Re-exports |

## Зависимости

```json
{
  "@teya/core": "workspace:*"   // только типы (AgentEvent, ProviderCapabilities, GenerationDetails)
}
```

Этот пакет **не зависит** от `@teya/cli`, `@teya/providers`, `@teya/memory`, `@teya/orchestrator`. Это позволяет переиспользовать его в любом другом проекте, который потребляет агентный цикл из `@teya/core`.

## Использование из кода

### Минимум

```ts
import { agentLoop } from '@teya/core'
import { AgentTracer, jsonExporter } from '@teya/tracing'

const tracer = new AgentTracer(jsonExporter('/tmp/traces.jsonl'), {
  capabilities: provider.capabilities,  // нужно для оценки cost
})

tracer.setContext({
  sessionId: 'sess-123',
  agentId: 'default',
  transport: 'cli',
  userMessage: 'привет',
})

for await (const event of agentLoop(deps, message, history)) {
  tracer.processEvent(event)
}
```

### Production: per-session + daily

```ts
import { AgentTracer, jsonExporter, sessionFileExporter, compositeExporter } from '@teya/tracing'

const exporter = compositeExporter(
  jsonExporter('~/.teya/traces/2026-04-12.jsonl'),     // daily
  sessionFileExporter('~/.teya/traces/sessions'),       // per-session route
)
const tracer = new AgentTracer(exporter, { capabilities: provider.capabilities })
```

### Background billing enrichment

OpenRouter возвращает фактическую цену через `/api/v1/generation?id=<id>` с задержкой 30–60s. `GenerationEnricher` поллит этот endpoint с экспоненциальным backoff и шлёт результат обратно в трейсер:

```ts
import { GenerationEnricher } from '@teya/tracing'

const enricher = new GenerationEnricher(provider, tracer)

for await (const event of agentLoop(...)) {
  tracer.processEvent(event)
  if (event.type === 'thinking_end' && event.generationId) {
    enricher.enqueue(event.generationId, tracer.getContext())
  }
}

// На shutdown — дать запросам закончиться:
await enricher.drain(60_000)
enricher.stop()
tracer.finishSession('exit')
```

### Sub-agent делегация

```ts
// В parent loop, при обработке delegate tool:
const delegateSpan = parentTracer.beginDelegateSpan(subAgentId, task)
const childTracer = parentTracer.spawnChild(delegateSpan.spanId, { agentId: subAgentId })

for await (const event of subAgentLoop(...)) {
  childTracer.processEvent(event)  // спаны идут в parent's exporter с правильным parent
}

parentTracer.finishDelegateSpan(delegateSpan, 'completed', { turns, cost })
```

Child tracer переиспользует exporter и `traceId` parent-а, но имеет независимый span state и default-parent (= delegate span). Благодаря этому иерархия `delegate → sub-agent.turn → llm.generate / tool.X` строится автоматически и в реальном времени, без post-hoc reconstruction.

### Query API из кода

```ts
import { listTracedSessions, summarizeSession, aggregateCost, findAnomalies, diffSessions } from '@teya/tracing'

const sessions = listTracedSessions('~/.teya/traces/sessions')
const breakdown = aggregateCost('~/.teya/traces/sessions')
const anomalies = findAnomalies('~/.teya/traces/sessions', 2 /* sigma */)
const diff = diffSessions('~/.teya/traces/sessions', 'abc12345', 'def67890')
```

Можно построить любую внешнюю аналитику, не парся jsonl руками.

## CLI viewer (`teya trace`)

Живёт в `@teya/cli` (`packages/cli/src/trace-cli.ts`), но всю логику тянет из этого пакета.

```
teya trace list                        # сессии с totals (newest first)
teya trace show <id> [--json]          # span tree одной сессии
teya trace cost                        # totals + by model
teya trace cost --by-tool              # p50/p95/p99/error_rate per tool
teya trace cost --by-session           # топ сессий по cost
teya trace tail                        # live-follow с running totals
teya trace anomalies [--sigma=N]       # outlier sessions (cost / tokens / errors)
teya trace diff <a> <b>                # дельта двух сессий
teya trace assert <id> --max-cost USD --max-tokens N --max-turns N --no-errors --no-fallback
                                       # exit code 0/1 — для CI/regression
teya trace backfill <id>               # дозалить actual cost для старых сессий
```

## Что добавить новый источник данных

Пример: хочется отдельно трекать загрузку embeddings в knowledge graph.

1. **Расширить событие в `@teya/core/types.ts`:**
   ```ts
   | { type: 'memory_query'; query: string; resultCount: number; latencyMs: number }
   ```

2. **Эмитить из source (`@teya/memory` или где удобно):**
   ```ts
   yield { type: 'memory_query', query, resultCount, latencyMs }
   ```

3. **Обработать в `tracer.ts`:**
   ```ts
   case 'memory_query': {
     const span = this.withContext(createSpan('memory.query', this.turnSpan?.spanId, this.traceId))
     span.attributes['memory.query'] = truncate(event.query, this.payloadLimit)
     span.attributes['memory.result_count'] = event.resultCount
     span.attributes['memory.latency_ms'] = event.latencyMs
     endSpan(span, 'ok')
     this.exporter(span)
     break
   }
   ```

4. **(Опционально) показать в viewer** — добавить ветку в `cmdShow` в `trace-cli.ts`.

Готово. Никакие другие модули не трогаются.

## Что добавить новый экспортёр

Пример: писать в DuckDB вместо jsonl.

```ts
// в exporters.ts
import Database from 'duckdb'

export function duckdbExporter(path: string): (span: Span) => void {
  const db = new Database.Database(path)
  // create table if not exists ...
  return (span) => {
    // INSERT INTO spans VALUES (...)
  }
}
```

И комбинируй через `compositeExporter(jsonExporter, duckdbExporter)`. Tracer ничего не знает о реализации.

## Атрибуты, которые имеет смысл смотреть

| Вопрос | Где смотреть |
|--------|-------------|
| Сколько токенов уходит на overhead (system + tools)? | `gen_ai.request.system_tokens`, `gen_ai.request.tools_tokens` per `llm.generate` |
| Где утечка времени — сеть или модель? | `http.latency_ms` vs `gen_ai.latency_ms` per `llm.generate` |
| Какая модель действительно ответила (после fallback)? | `gen_ai.response.model` (vs `gen_ai.request.model`) |
| Сработал ли fallback в этой сессии? | Существование спана `provider.fallback` или `fallback.fired = true` на agent.turn |
| Сколько провайдер сэкономил кэшем? | `gen_ai.usage.cached_input_tokens` per `llm.generate` |
| Какие тулзы самые медленные? | `teya trace cost --by-tool` (p95/p99) |
| Какие тулзы чаще всего падают? | `teya trace cost --by-tool` (err%) |
| Эта сессия дороже обычных? | `teya trace anomalies` |
| Что изменилось между двумя прогонами того же запроса? | `teya trace diff <a> <b>` |
| Помог ли компакт сэкономить токены? | `context.compaction_saved_tokens` на следующем `llm.generate` |
| Точная цена сессии (а не оценка)? | `session.cost.usd` на agent.session, либо сумма `gen_ai.cost.usd_actual` |

## TODO / возможные расширения

- **Streaming TTFT** — поле `transport.ttftMs` уже в типах. Заполнится автоматически, когда openrouter переключится на streaming `generate()`.
- **Per-skill token attribution** — `buildSystemPrompt` должен вернуть не только prompt, но и breakdown по компонентам (SOUL, AGENTS, skills, verifiedCatalog). Tracer добавит атрибут `system_prompt.parts.<name>_tokens`.
- **OTLP enhancements** — `otlpExporter` уже работает, но не поддерживает batching метрик. Можно добавить `otlpMetricExporter` для отправки агрегатов в Prometheus/Grafana.
- **DuckDB exporter** — для SQL-аналитики над сессиями.
- **TUI dashboard** (`teya trace dashboard`) — live updates с blessed/ink.
- **MCP-tool latency split** — отдельный child span `mcp.<server>.<tool>` чтобы видеть network round-trip отдельно от исполнения.
