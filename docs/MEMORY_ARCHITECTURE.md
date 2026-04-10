# Teya Long-Term Memory Architecture

Статус: proposal (2026-04-09)
Автор: architect agent
Контекст: @teya/memory уже существует (SessionStore, KnowledgeGraph, AssetStore, intelligence.ts), но консолидация не запущена как автономный процесс и нет продуманного retrieval-контура. Документ описывает целевую архитектуру и план миграции.

---

## 1. Текущее состояние

### Что уже работает
- **SessionStore** (`packages/memory/src/sessions.ts`) — индекс сессий в SQLite + JSON-файлы сообщений (`~/.teya/sessions/{id}.json`). Умеет `getUnsummarized()`, `getSessionsForDate()`, `updateSummary()`.
- **KnowledgeGraph** (`packages/memory/src/knowledge.ts`) — SQLite с таблицами `entities`, `facts`, `relations`. Поддерживает:
  - embeddings в `facts.embedding` (Float32 BLOB),
  - dedup при `addFact` (word overlap + cosine ≥0.85 если есть embedding),
  - `supersedeFact()` с цепочкой `superseded_by`,
  - hybrid search (keyword LIKE + semantic cosine).
- **intelligence.ts** — функции `summarizeSession`, `batchSummarize`, `extractDailyKnowledge`. Промпты сырые, extraction написан но **не вызывается из scheduler**.
- **TaskStore** (`packages/scheduler/src/task-store.ts`) — SQLite cron + one-off задачи с execution history. daemon уже крутится.
- **AssetStore** — blob-хранилище (картинки, файлы), отдельный контур, трогать не будем.
- **core:memory tool** (`tools.ts`) — exposing KG агенту через действия `read/write/search/entities/relate/update`.

### Чего не хватает (больно)
1. **Нет автономного консолидационного процесса.** `extractDailyKnowledge` существует, но нигде не зашедулен. Scheduler daemon его не знает.
2. **Одна таблица `facts` для всего** — и для устойчивых утверждений ("Evgeny работает в MPSTATS"), и для эпизодов ("вчера задеплоил Loocl"). Нет разделения semantic vs episodic → консолидация замусоривает поиск.
3. **Нет wiki-слоя.** Markdown-документы про проекты живут в Obsidian/файлах, KG и wiki не связаны. Тея не умеет поддерживать `~/.teya/wiki/` как источник правды длинных нарративов.
4. **Retrieval слеп.** Нет автоматического вытаскивания релевантного контекста в начале разговора. Агент должен явно дернуть `core:memory` tool. Пассивной инъекции нет.
5. **Нет retention-политики.** Старые сессии копятся бесконечно. Сжатия в "месячное саммари" нет.
6. **Конфликты разрешаются наивно.** `isSimilarAsync` сравнивает только текущую со свежими фактами у той же entity; если факт поменял смысл (статус проекта), он просто добавится рядом как новый, `superseded_by` ставится только через явный `updateFact` action.
7. **Нет tracing консолидации.** Невозможно понять, что Тея решила изменить прошлой ночью.

---

## 2. Целевая архитектура

### 2.1. Трёхслойная модель памяти

Вдохновлено Letta/MemGPT (core/archival/recall) + Mem0 (fact-store) + GraphRAG (community summaries).

```
┌─────────────────────────────────────────────────────────────────┐
│  WORKING MEMORY (in-context, ephemeral)                          │
│  — текущие messages сессии + системный блок "core facts"         │
│  — инжектится в prompt каждый turn                               │
└─────────────────────────────────────────────────────────────────┘
                           ▲
                           │ retrieval (pre-turn hook)
                           │
┌─────────────────────────────────────────────────────────────────┐
│  SEMANTIC MEMORY (long-term, stable)                             │
│  ├─ KnowledgeGraph: entities + canonical_facts + relations       │
│  │   (устойчивые утверждения: "Evgeny — solo builder",           │
│  │    "Loocl использует Fastify")                                │
│  └─ WikiStore: ~/.teya/wiki/*.md (длинные нарративы,             │
│      один .md = один entity: проект, человек, концепция)        │
└─────────────────────────────────────────────────────────────────┘
                           ▲
                           │ consolidation (nightly cron)
                           │
┌─────────────────────────────────────────────────────────────────┐
│  EPISODIC MEMORY (raw + recent)                                  │
│  ├─ SessionStore: сырые сессии (messages + summary)              │
│  └─ episodes table: "событие" = факт с временной меткой          │
│      и указанием на session_id (что произошло, а не что есть)    │
└─────────────────────────────────────────────────────────────────┘
```

**Почему гибрид (graph + wiki + episodic), а не чистый KG или чистый vector:**
- **Graph** отлично держит атомарные факты, связи, дедуп. Плохо — длинные истории.
- **Wiki (md-файлы)** держит длинные нарративы, человекочитаем, можно редактировать руками, Obsidian-совместим. Плохо — дедуп/поиск.
- **Episodic** нужен для "что было вчера" — сырые события без мгновенной канонизации.
- **Эмбеддинги** — не отдельный слой, а индекс поверх facts и wiki-chunks.

### 2.2. Схема БД (новые таблицы в `knowledge.db`)

```sql
-- эпизоды: событийные факты с источником
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  embedding BLOB,
  consolidated_into INTEGER REFERENCES facts(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_episodes_session ON episodes(session_id);
CREATE INDEX idx_episodes_entity ON episodes(entity_id);
CREATE INDEX idx_episodes_occurred ON episodes(occurred_at DESC);

-- расширить facts: категория + confidence + valid_until
ALTER TABLE facts ADD COLUMN kind TEXT DEFAULT 'semantic';
  -- 'semantic' (стабильный), 'preference', 'status' (меняется)
ALTER TABLE facts ADD COLUMN confidence REAL DEFAULT 1.0;
ALTER TABLE facts ADD COLUMN valid_from TEXT;
ALTER TABLE facts ADD COLUMN valid_until TEXT;  -- NULL = актуален

-- wiki: md-документы, один на entity
CREATE TABLE IF NOT EXISTS wiki_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER UNIQUE REFERENCES entities(id) ON DELETE CASCADE,
  slug TEXT UNIQUE NOT NULL,        -- 'projects/loocl'
  file_path TEXT NOT NULL,          -- '~/.teya/wiki/projects/loocl.md'
  title TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  word_count INTEGER DEFAULT 0,
  last_consolidated_at TEXT
);

-- chunks wiki для поиска (вектор + BM25-like)
CREATE TABLE IF NOT EXISTS wiki_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER REFERENCES wiki_pages(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  heading_path TEXT,                 -- 'Tech > Scraper'
  content TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX idx_wiki_chunks_page ON wiki_chunks(page_id);

-- аудит консолидации: что, когда, какие изменения
CREATE TABLE IF NOT EXISTS consolidation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,              -- running, done, failed
  sessions_processed INTEGER DEFAULT 0,
  episodes_created INTEGER DEFAULT 0,
  facts_added INTEGER DEFAULT 0,
  facts_superseded INTEGER DEFAULT 0,
  wiki_pages_updated INTEGER DEFAULT 0,
  llm_cost_usd REAL DEFAULT 0,
  notes TEXT
);
```

### 2.3. Потоки данных

```
   chat turn                  session end               03:00 nightly
       │                           │                          │
       ▼                           ▼                          ▼
┌──────────────┐          ┌──────────────┐           ┌───────────────────┐
│ pre-turn     │          │ post-session │           │ consolidation     │
│ retrieval    │          │ summary      │           │ run (cron)        │
│              │          │              │           │                   │
│ extract      │          │ summarize    │           │ Phase A: episodes │
│ query from   │          │ Session →    │           │ Phase B: promote  │
│ last user    │          │ update       │           │   → semantic/wiki │
│ msg → search │          │ sessions row │           │ Phase C: resolve  │
│ KG+wiki      │          │              │           │   conflicts       │
│ → inject     │          └──────────────┘           │ Phase D: compact  │
│ system block │                                      │   old sessions    │
└──────────────┘                                      └───────────────────┘
```

### 2.4. Консолидационный конвейер (ядро)

Запускается через scheduler (`cron: "15 3 * * *"`, Europe/Moscow). Один job = один `consolidation_runs` row. Реализация — новый модуль `packages/memory/src/consolidation.ts`.

**Phase A — Episode extraction (за последние 24ч):**
1. `sessionStore.getSessionsForDate(yesterday)` → список сессий.
2. Для каждой сессии, у которой нет `last_consolidated_at`:
   - condensed messages (≤3k chars, как сейчас в intelligence.ts),
   - LLM вызов с `EPISODE_EXTRACTION_PROMPT` → список эпизодов `{entity_hint, content, kind, occurred_at?, tags}`,
   - запись в `episodes` (entity_id создаётся лениво через `kg.addEntity`),
   - эмбеддинг эпизода через `embeddingProvider`.
3. Помечаем сессию как consolidated (новая колонка `sessions.consolidated_at`).

**Phase B — Promotion (episodes → semantic):**
1. Группируем эпизоды за окно 7 дней по `entity_id`.
2. Для каждой группы ≥2 эпизодов с похожим смыслом (cosine ≥0.8) — вызов LLM с `PROMOTION_PROMPT`:
   - вход: существующие `facts` у entity + новые эпизоды,
   - выход: `{canonical_facts: [...], supersede: [{old_id, new_content}], wiki_update: "markdown section"}`.
3. Применяем:
   - `kg.addFact(..., kind: 'semantic'|'preference'|'status')` — уже с dedup,
   - `kg.supersedeFact(old, new)` для каждого supersede,
   - `wikiStore.upsertSection(entityId, heading, markdown)` — патчим md-файл,
   - `episodes.consolidated_into = fact.id` для всех группируемых эпизодов.

**Phase C — Conflict resolution:**
- Для фактов с `kind='status'` при добавлении нового:
  - если есть предыдущий `valid_until IS NULL` → ставим `valid_until = new.valid_from` и `superseded_by = new.id`.
- Для `kind='semantic'` — LLM-арбитраж при cosine 0.6-0.85 (похоже, но не дубль): промпт `CONFLICT_PROMPT` решает `merge | supersede | keep_both`.

**Phase D — Compaction / retention:**
- Сессии старше 30 дней: удалить `messages.json`, оставить только metadata в SQLite. (Уже есть `updateSummary`, не удаляем summary.)
- Эпизоды старше 90 дней с `consolidated_into IS NOT NULL` → удалить.
- Эпизоды старше 90 дней без консолидации → оставить, но пометить `tags += ['orphan']` для debug.

### 2.5. Retrieval (pre-turn hook)

Новый модуль `packages/memory/src/retrieval.ts` экспортирует `MemoryRetriever`:

```ts
interface RetrievalResult {
  coreBlock: string       // always-on: 5-10 топ-фактов про user (pinned)
  contextBlock: string    // query-specific: выбранные факты + wiki chunks
  references: Reference[] // для tracing
}

class MemoryRetriever {
  async retrieve(opts: {
    lastUserMessage: string
    sessionId: string
    maxTokens: number      // бюджет (по умолчанию 1500)
  }): Promise<RetrievalResult>
}
```

Алгоритм:
1. **Core block** — фиксированный список `pinned=true` фактов про entity 'user' (до 500 токенов). Редактируется руками или консолидатором. Кешируется в памяти.
2. **Query extraction** — если last user msg короткий (≤20 слов), берём его целиком как query. Иначе LLM-вызов (cheap, ollama/nano) → `{query, entities: [...]}`.
3. **Hybrid search:**
   - `kg.search(query, 10)` — facts,
   - `wikiStore.searchChunks(query, 5)` — wiki chunks,
   - rerank через cosine + boost если entity упомянута в query,
   - обрезать под бюджет токенов.
4. **Format** как system message:
   ```
   <memory>
   [core]
   - user is Evgeny, solo builder, Russian language
   - ...
   [context]
   From wiki: projects/loocl#Tech — <excerpt>
   Fact: Loocl использует Fastify+BullMQ [semantic, 2026-02-10]
   </memory>
   ```
5. **Когда вызывать:** инжектится в `core` пакете при построении prompt, перед каждым turn пользователя. Не вызываем если `messages.length > 40` (уже много контекста) или если `lastUserMessage.length < 5`.

### 2.6. WikiStore

Новый модуль `packages/memory/src/wiki.ts`. Файлы лежат в `~/.teya/wiki/{slug}.md`, одна страница на entity. Формат:

```markdown
---
entity: loocl
type: project
updated: 2026-04-09
---
# Loocl

## Overview
Автоматизация Яндекс.Карт для локального бизнеса.

## Tech
- Frontend: Next.js
- Backend: Fastify + BullMQ
...

## History
- 2026-02-10: запуск reports v2
```

API:
- `upsertPage(entityId, slug, title) → pageId`
- `upsertSection(pageId, headingPath, markdown)` — патчит конкретный раздел (парсинг по `##`/`###`)
- `getPage(entityId): string | null`
- `searchChunks(query, limit): Chunk[]` — embedding search over `wiki_chunks`
- `reindex(pageId)` — rechunk + re-embed (chunk size ~400 tokens)

Wiki пересобирается только консолидатором; рантайм только читает.

### 2.7. Контракты между пакетами

```
packages/memory (экспортирует)
  ├─ SessionStore            (как сейчас)
  ├─ KnowledgeGraph          (как сейчас + новые kind/valid_*)
  ├─ WikiStore               [NEW]
  ├─ MemoryRetriever         [NEW]
  ├─ Consolidator            [NEW]  — класс с методом run()
  ├─ EpisodeStore            [NEW]  — тонкая обёртка над episodes table
  └─ prompts/*.ts            [NEW]  — все промпты в одном месте

packages/core
  └─ уже импортирует SessionStore; добавляем вызов MemoryRetriever
     в агентский run-loop перед LLM-вызовом (feature flag)

packages/scheduler
  └─ daemon-executor.ts: добавить built-in job 'memory:consolidate'
     который получает ConsolidatorDeps и зовёт consolidator.run()

packages/providers
  └─ без изменений — Consolidator принимает LLMCall (уже есть паттерн
     в intelligence.ts)

packages/tracing
  └─ опционально: Consolidator пишет события 'memory.phase_a.done' и
     т.п. через существующий tracing bus
```

---

## 3. Новые файлы/модули

### Создать
- `packages/memory/src/episodes.ts` — `EpisodeStore` класс.
- `packages/memory/src/wiki.ts` — `WikiStore` (md-файлы + chunks).
- `packages/memory/src/retrieval.ts` — `MemoryRetriever`.
- `packages/memory/src/consolidation.ts` — `Consolidator` с `run(): Promise<ConsolidationReport>`.
- `packages/memory/src/prompts/` — отдельные `.ts` файлы с промптами (episode, promotion, conflict, retrieval-query).
- `packages/memory/src/migrations/002_episodes_wiki.sql` — миграция БД (или inline в knowledge.ts, по существующему паттерну).
- `packages/scheduler/src/jobs/memory-consolidate.ts` — built-in job handler, вызывающий Consolidator.
- `docs/MEMORY_ARCHITECTURE.md` — этот документ.
- `packages/memory/tests/consolidation.test.ts` — integration test с fake LLM.
- `packages/memory/tests/retrieval.test.ts` — с фиктивными фактами.

### Модифицировать
- `packages/memory/src/knowledge.ts` — добавить миграции (kind, confidence, valid_from, valid_until), метод `addFactWithKind()`, метод `resolveStatusConflict(entityId, newFact)`.
- `packages/memory/src/sessions.ts` — добавить колонку `consolidated_at`, методы `markConsolidated(id)`, `getUnconsolidated(since)`.
- `packages/memory/src/index.ts` — экспорты новых классов.
- `packages/core/src/` (agent loop) — вызов `MemoryRetriever` под feature-флагом `TEYA_MEMORY_RETRIEVAL=1`.
- `packages/scheduler/src/daemon-executor.ts` — регистрация built-in job.
- `packages/cli/src/index.ts` — команды:
  - `teya memory consolidate [--date YYYY-MM-DD] [--dry-run]`
  - `teya memory wiki list | show <slug> | edit <slug>`
  - `teya memory stats`
  - `teya memory pin <fact_id> / unpin <fact_id>`

---

## 4. План миграции (3 фазы)

### Фаза 1 — Episodic + Consolidation skeleton (1-2 дня)

Цель: научить Тею автономно превращать сессии в эпизоды каждую ночь. Semantic слой пока не трогаем — продолжает работать старая логика `extractDailyKnowledge`.

Шаги:
1. Миграция knowledge.db: добавить `episodes`, `consolidation_runs`, `facts.kind/confidence/valid_*`, `sessions.consolidated_at`.
2. `EpisodeStore` + тесты (pure SQL, без LLM).
3. `Consolidator` Phase A only, с промптом `EPISODE_EXTRACTION_PROMPT` (черновик в §6).
4. Built-in job в scheduler + CLI команда `teya memory consolidate`.
5. Регистрация cron `15 3 * * *` при `teya init` (добавить в seed).
6. Ручной прогон на реальных сессиях, проверка Obsidian-экспорта (опционально).

Критерий готовности: через ночь появляется row в `consolidation_runs` со статусом `done` и эпизоды привязаны к сессиям. Ничего в старом `extractDailyKnowledge` не сломалось.

### Фаза 2 — Promotion + Wiki + Retrieval (3-4 дня)

Цель: эпизоды превращаются в semantic facts и wiki-страницы, retrieval начинает инжектить контекст в разговор.

Шаги:
1. `WikiStore` + тесты, rechunk/embed pipeline.
2. `Consolidator` Phase B (promotion) + Phase C (conflict resolution) с двумя промптами.
3. `MemoryRetriever` + feature flag интеграция в `packages/core` agent loop.
4. CLI команды `wiki list/show`, `memory stats`, `memory pin`.
5. Evaluation: прогон старых сессий через консолидатор в dry-run, ручная проверка wiki на 5 проектов (loocl, qreata, speeqa, mpstats, teya-agent).

Критерий готовности: после ночной консолидации `~/.teya/wiki/projects/loocl.md` содержит вменяемое саммари, cosine-поиск по нему находит релевантные секции, retrieval инжектит <memory> блок, разговоры с Теей демонстрируют осведомлённость без явных `core:memory` tool calls.

### Фаза 3 — Retention, tracing, evals (1-2 дня)

Цель: долгосрочная устойчивость.

Шаги:
1. Phase D (compaction) в Consolidator — сжатие старых сессий, чистка эпизодов.
2. Интеграция с `@teya/tracing`: события консолидации пишутся, видны в digest.
3. Eval-сьюит в `evals/memory/`: синтетические сценарии (факт меняется → supersede, вопрос через неделю → retrieval находит).
4. Документация: README в `packages/memory/` с диаграммой и как руками отредактировать wiki.
5. Запуск в prod: scheduler daemon подхватывает новый cron, мониторим неделю.

---

## 5. Edge cases и решения

| Кейс | Решение |
|---|---|
| Факт поменялся (проект сменил статус) | `kind='status'` → при promotion Phase C автоматически ставит `valid_until` старому и создаёт новый. История не теряется (старый в БД). |
| Дубликат в двух сессиях одного дня | Phase A дедуп через cosine ≥0.85 внутри пакета эпизодов до записи в БД. |
| LLM придумал несуществующую entity | Phase B проверяет: если entity упоминается только в 1 эпизоде и не связан с другими через относительные местоимения — не промотится в semantic, остаётся эпизодом (≥2 упоминаний требуется). |
| Консолидация упала посреди процесса | `consolidation_runs` row остаётся `running`. Next run: cleanup — помечаем как `failed`, начинаем заново, episodes Phase A идемпотентен (по `session_id + content_hash`). |
| Конкурентная консолидация | Advisory lock через `consolidation_runs` — перед стартом проверяем `WHERE status='running'`, если есть — abort. |
| Wiki разросся (>50k слов) | `wiki_chunks` даёт гранулярность; при reindex страница режется на chunks ~400 токенов. Retrieval выдаёт только релевантные chunks, не всю страницу. |
| Пользователь руками отредактировал `.md` | `WikiStore` при upsertSection делает git-like merge по heading path: если heading совпадает — заменяет только этот раздел, руками добавленные разделы (не в entity schema) остаются. В Phase 3 добавить `teya memory wiki lock <slug>` для ручных страниц. |
| Контекст ретривала слишком длинный | Жёсткий бюджет `maxTokens` (default 1500). Core block ≤500, context ≤1000. Усечение по facts, wiki chunks обрезаются до 200 токенов каждый. |
| Эмбеддинги недоступны (ollama выключен) | Hybrid search деградирует до keyword-only. Retrieval использует `kg.search()` без semantic path. Consolidation Phase B использует только keyword matching для группировки — хуже, но не падает. |
| Приватные/секретные данные в сессии | Pre-extraction filter: если tool output содержит `credentials.env` или pattern API ключа → redact перед передачей в LLM. Новый hook в `condenseMessages`. |
| LLM-провайдер дорогой | Consolidator принимает два LLMCall: `cheap` (gpt-4o-mini или локальная ollama) для Phase A, `smart` (sonnet) только для Phase B promotion. Бюджет дневной консолидации <$0.10. |

### Retention политика (default)

| Слой | TTL | Действие |
|---|---|---|
| `messages.json` файлы | 30 дней | Удаляем файл, оставляем summary в SQLite |
| `episodes` без `consolidated_into` | 90 дней | tag 'orphan', не удаляем |
| `episodes` с `consolidated_into` | 90 дней | Удаляем (факт уже в semantic) |
| `facts` с `superseded_by` | forever | Не удаляем (история) |
| `facts` без `superseded_by` | forever | Не удаляем |
| `wiki_pages` | forever | Пересобираются, не удаляются |
| `consolidation_runs` | 365 дней | Prune |

---

## 6. Черновики промптов

Финальные промпты будут в `packages/memory/src/prompts/*.ts`. Ниже — рабочие черновики.

### 6.1. EPISODE_EXTRACTION_PROMPT (Phase A, cheap LLM)

```
You are Teya's episodic memory processor. You receive a conversation from the past day.
Extract EPISODES — things that happened, decisions made, new information surfaced.

An episode is:
- Specific and tied to a moment ("today Evgeny decided X", "fixed bug Y")
- NOT a general truth ("Evgeny uses TypeScript" — that's semantic, skip)
- NOT trivia ("user said hello")

For each episode, output:
{
  "entity": "name of main subject (project, person, tool)",
  "entity_type": "project|person|tool|concept",
  "content": "what happened, one sentence",
  "kind": "event|decision|status_change|observation",
  "tags": ["tag1", "tag2"],
  "occurred_at": "ISO date if explicitly mentioned, else null"
}

Rules:
- Use the language of the conversation.
- Max 15 episodes per session.
- Skip tool-call noise and filler.
- If two episodes are near-duplicates, emit once.

Respond ONLY as JSON: {"episodes": [...]}
```

### 6.2. PROMOTION_PROMPT (Phase B, smart LLM)

```
You are Teya's memory consolidator. You are given:
1. An entity and its existing canonical facts
2. New episodes about this entity from the past week

Your job: decide what becomes a stable semantic fact, what updates an existing fact,
and what becomes a new section in the entity's wiki page.

Output JSON:
{
  "new_facts": [
    {"content": "...", "kind": "semantic|preference|status", "tags": [...], "confidence": 0.0-1.0}
  ],
  "supersede": [
    {"old_fact_id": N, "new_content": "...", "reason": "..."}
  ],
  "wiki_update": {
    "heading": "Tech|History|Status|Overview",
    "markdown": "## Heading\n\nContent..."
  } | null,
  "discard_episode_ids": [N, ...]   // noise that shouldn't be promoted
}

Rules:
- Promote a fact only if supported by ≥2 episodes OR an explicit user statement.
- If new info contradicts existing fact — use supersede, not new_fact.
- kind='status' for things that change over time (project stage, current focus).
- kind='preference' for user's stable habits/choices.
- kind='semantic' for stable truths (tech stack, roles, relationships).
- wiki_update: narrative prose, not bullet lists of facts (those are already in graph).
- Language: match the language of episodes.
```

### 6.3. CONFLICT_PROMPT (Phase C, smart LLM)

```
Two facts about the same entity are similar but not identical. Decide:
- merge: they say the same thing, write the merged version
- supersede: new one replaces old one (old became false)
- keep_both: they describe different aspects, both valid

Fact A (existing, id=X, created YYYY-MM-DD): "..."
Fact B (new candidate): "..."

Output: {"decision": "merge|supersede|keep_both", "result": "..." | null, "reason": "..."}
```

### 6.4. RETRIEVAL_QUERY_PROMPT (pre-turn, cheap)

```
Extract a search query from the user's message for memory lookup.
Output JSON: {"query": "...", "entities": ["name1", "name2"]}
- query: keywords for semantic search (no stop words, core nouns/verbs)
- entities: named things the user explicitly mentions (projects, people, tools)
- If the message is trivial (greeting, ack), return {"query": "", "entities": []}
```

---

## 7. Trade-offs и риски

**Плюсы:**
- Эпизод/семантика разделены → поиск не замусорен событийным шумом.
- Wiki даёт человекочитаемый и редактируемый слой, совместимый с Obsidian-воркфлоу Evgeny.
- Consolidator изолирован в отдельном модуле → легко тестировать без скедулера.
- Retrieval опционален (feature flag) → можно включать постепенно.
- История фактов сохраняется через supersede (audit trail).

**Что принимаем:**
- Нет сильного эмбеддинг-индекса (pgvector и т.п.) — линейный cosine scan. Для ≤50k фактов это ~50ms, жить можно. Если прирастёт — перейти на sqlite-vss.
- Консолидация — LLM-heavy процесс. Неделя прогонов при нестабильных промптах может замусорить граф. Защита: dry-run режим + бэкап knowledge.db перед каждым run.
- Wiki merge по heading-path — хрупкий, если Evgeny переименует заголовки. Митигация: `wiki lock` и ручное редактирование только в Phase 3.
- Monitoring: без tracing (Phase 3) консолидация — чёрный ящик. Пока Phase 1-2 — читаем `consolidation_runs.notes`.

**Риски:**
- LLM извлекает галлюцинации как "факты". Митигация: confidence<0.7 не промотится в semantic, остаётся эпизодом.
- Дубли сущностей из-за вариативности именования ("Loocl" vs "loocl" vs "loocl-parsers"). Митигация: entity alias table в фазе 3 (пока — unique `(name, type)` с нормализацией в нижний регистр при вставке через Consolidator).
- Разрастание wiki_chunks эмбеддингов. Митигация: retention на chunks при reindex — старые удаляются.

---

## 8. Готовность Фазы 1 — чеклист

- [ ] Миграция SQL применена (episodes, consolidation_runs, новые колонки)
- [ ] EpisodeStore + тесты зелёные
- [ ] Consolidator.runPhaseA() работает на fake LLM
- [ ] CLI `teya memory consolidate --dry-run` выводит план без записи
- [ ] CLI `teya memory consolidate` создаёт эпизоды и помечает сессии
- [ ] Scheduler job `memory:consolidate` зарегистрирован, seed cron 15 3 * * *
- [ ] Реальный прогон на 7 днях истории — эпизоды осмысленные
- [ ] Rollback план: `teya memory rollback <consolidation_run_id>` (опционально, нельзя раскатывать без него в Phase 2)

---

Конец документа.
