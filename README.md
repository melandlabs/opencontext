<div align="center">

# OpenContext

**The context runtime substrate that powers agentic applications.**

A temporal context graph, a memory API, retrieval primitives,
and a multi-platform integration mesh — designed to be embedded into any
host process.

<p align="center">
<a href="./README.md">English</a> · <a href="./README-zh.md">简体中文</a>
</p>

[![License](https://img.shields.io/badge/License-Apache_2.0-F8D52A?logo=apache)](./LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/xkJaJyWcsv)
[![X](https://img.shields.io/badge/X-Follow-000000?logo=x&logoColor=white)](https://x.com/AlloomiAI)

</div>

<div align="center">

⭐ **If you find opencontext useful, please consider giving us a star on GitHub!** It helps more people discover the project and motivates us to keep building. 🙏

[![GitHub Repo stars](https://img.shields.io/github/stars/melandlabs/opencontext?style=social&label=Star)](https://github.com/melandlabs/opencontext)

</div>

---

## What is OpenContext?

**OpenContext** is the context runtime layer that sits underneath an agentic
application — and the substrate you build your own agent on top of.
It is not a UI, a chat surface, or a model provider —
it is the glue between the things that make an agent useful: durable
memory, retrieval, context correction, multi-platform connectivity,
scheduled awareness, and a deterministic loop engine, all behind one dependency.

→ Read [`docs/architecture.md`](./docs/architecture.md) for the full
data model, the lifecycle of a fact, and the transport surface map.

## Who is it for?

OpenContext fits teams who need to **engineer their context** — that is, teams whose day-to-day work runs straight into the problems OpenContext was built to solve. Each bullet spells out the pain and how OpenContext addresses it:

- **Software engineering teams.** Decisions scatter across GitHub PRs, Linear tickets, Slack threads, and Notion docs — across people, tools, and quarters. New hires ask *"why did we pick X?"* and no one can answer. OpenContext's temporal graph stores every fact with `valid_from / valid_until`, so *"what did we believe last quarter?"* is a real, citable query — not a guess.
- **Efficiency / productivity engineering teams.** The people building internal automation for the rest of the company. They don't want another SaaS — they want a runtime they can drop into a CLI, an MCP server, or a daemon. OpenContext is library-first, and the deterministic Loop engine only invokes the LLM when there is real work, so it does not become a token-burning always-on loop.
- **Office-assistant products.** Assistants that live inside Telegram, iMessage, WhatsApp, Lark/Feishu, and friends. Same agent code, same context across channels. `IntegrationRecord` hides credentials, rate-limits, and reconnect logic, while `platform + messageId` is the natural audit trail for personal and work data.
- **Financial trading teams.** Every order, rebalance, and risk decision needs to be traceable and auditable. The temporal graph plus append-only corrections mean *"what was the strategy in April?"* is a queryable fact, not a buried guess — and the trail lines up with MiFID II / SEC retention rules.
- **Legal, healthcare and other audited domains.** Law firms, hospitals, and similar teams where every judgement needs per-fact provenance, append-only corrections, and exportable compliance evidence.
- **Multi-agent and autonomous-workflow authors.** Need scheduled, deterministic wake-up instead of an LLM loop all the way down. `packages/loop` ships exactly that separation.

## Features

|     | Capability                                                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🧠  | **[Temporal Context Graph](./docs/architecture.md#the-temporal-context-graph)** | A directed acyclic graph where every fact has `valid_from` / `valid_until`. Supersession, contradiction, and merge are first-class edges — corrections are append-only, not destructive.                                                                                                                                                                                                                |
| 🔌  | **[Platform Integration Mesh](./packages/integrations)**                        | One uniform `IntegrationRecord` shape across Gmail, Slack, Telegram, Linear, Jira, iMessage, Feishu, Weixin, … — credential rotation, rate-limit handling, and reconnect logic live behind the adapter.                                                                                                                                                                                                  |
| ⏰  | **[Deterministic Loop Engine](./packages/loop)**                                | A scheduler that wakes up, decides whether there is real work, and only then calls into the agent runtime. LLM calls are not the foundation — they are the last step.                                                                                                                                                                                                                                  |
| 🔍  | **[Retrieval Primitives](./packages/rag)**                                      | Chunking, embeddings, parsers (PDF/ZIP/text), sqlite-vec + pgvector + Chroma adapters. Mix backends without rewriting the recall pipeline.                                                                                                                                                                                                                                                              |
| 🤖  | **[Agent Runtime](./packages/ai)**                                              | AI SDK wrappers, sandbox providers (native / Claude / Vercel), MCP server, memory-consolidation job, image + audio generation.                                                                                                                                                                                                                                                                          |
| 🪶  | **[Library-First API](./packages/opencontext)**                                 | Install once with `pnpm add @melandlabs/opencontext` and get the contracts, memory store, retrieval primitives, loop engine, and agent runtime. No React, Next, or Tauri required.                                                                                                                                                                                                                    |
| 🛡️  | **[Audit + Encrypted Storage](./packages/audit)**                               | Structured audit logging to `~/.opencontext/logs/audit.jsonl`, Fernet symmetric encryption for secrets, URL allowlist/blocklist for outbound calls.                                                                                                                                                                                                                                                       |

## Benchmarks

Third-party memory and long-context recall benchmarks (numbers current as of 2026-08):

| Benchmark     | Score | What it measures                                                  |
| ------------- | ----- | ----------------------------------------------------------------- |
| LongMemEval-S | 97.6% | Long-term memory recall across long sessions                      |
| LoCoMo-V2     | 97.4% | QA over long multimodal conversations                            |
| BEAM @ 10M    | 67.0% | Factual recall at a 10M-token context window                      |

## Quick Start

There are four ways to get opencontext into your project. Pick the one
that matches what you're building.

### 1. Embed the runtime into your own app

```bash
pnpm add @melandlabs/opencontext
```

A 30-second example of the memory API:

```ts
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

// The store defaults to SQLite at MEMORY_STORE_DB_PATH (./memory.db by
// default). Each call returns an awaitable handle.
const store = await createMemoryStore();
const messages = await getRawMessageManager();

// A message is one fact: a single piece of content attributed to a user.
// `messageId` makes the call idempotent across re-ingest.
const now = Date.now();
await messages.storeMessages([
	{
		messageId: "msg-1",
		userId: "u-42",
		content: "User prefers dark mode in all tools",
		platform: "test",
		botId: "bot-1",
		timestamp: now,
		createdAt: now,
	},
]);

// Unified search fans out to memory + insights + knowledge. Sources you
// haven't wired up just emit a warning — fine for a single-backend deploy.
const hits = await store.searchUnifiedMemory({
	userId: "u-42",
	query: "What does the user prefer?",
	limit: 5,
});
// hits.count    — number of results
// hits.sources  — which sub-indexes were actually consulted
// hits.warnings — per-source degradation (e.g. missing embedder)
```

### 2. Build this monorepo from source

```bash
git clone https://github.com/melandlabs/opencontext.git
cd opencontext
pnpm install
pnpm -r build
```

### 3. Run the HTTP daemon from npm

```bash
# After `pnpm add -g @melandlabs/opencontext`, the bin is on PATH:
opencontext http \
  --embedding-provider local \
  --memory-backend sqlite-vec \
  --host 127.0.0.1 --port 7421
# Or, without a global install, via npx:
npx -y @melandlabs/opencontext http \
  --embedding-provider local --memory-backend sqlite-vec
curl http://127.0.0.1:7421/health
```

### 4. Wire the MCP server into Claude Desktop / Cursor

```bash
opencontext mcp \
  --embedding-provider local \
  --memory-backend sqlite-vec
```

## Examples

The [`examples/`](./examples/) workspace ships a runnable example per
capability area. Clone, install, and run:

```bash
git clone https://github.com/melandlabs/opencontext.git
cd opencontext/examples
pnpm install
pnpm test
```

See [`examples/README.md`](./examples/README.md) for the full walkthrough.

## Common usage patterns

### The memory API

`@melandlabs/opencontext` exposes two factory calls plus a small,
flat search surface. Writes go through the raw-message manager and
remain idempotent on `messageId`; reads fan out to memory + insights +
knowledge and degrade gracefully when a source is unconfigured. See
[`packages/memory-store/README.md`](./packages/memory-store/README.md)
for the full configuration matrix and recipes.

| Symbol                            | Use it for                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `createMemoryStore(config?)`      | Boot the store. Returns `{ raw, search, getRawMessageManager, searchUnifiedMemory, … }`. |
| `getRawMessageManager()`          | Resolve the active raw-message manager (SQLite by default, Postgres when registered).   |
| `manager.storeMessages(messages)` | Ingest facts. Idempotent on `messageId`. Each row carries the full `RawMessage` shape. |
| `store.searchUnifiedMemory(opts)` | Unified search across memory + insights + knowledge; unconfigured sources emit warnings. |

### Temporal queries (time travel)

Every fact in the underlying context graph carries `valid_from` and
`valid_until`, so an as-of query is "the facts whose validity
interval covered `t`". The unified search API does not expose
point-in-time filtering directly — temporal access lives one layer
deeper, in `@melandlabs/ai/memory-consolidation` (`graph-aware-query`)
and `@melandlabs/indexeddb/memory-graph-evolution`. See those
packages for as-of recall.

### MCP server

`@melandlabs/opencontext` exposes the same operations over
stdio — usable from Claude Desktop, Cursor, Claude Code, Codex CLI,
or any MCP-capable agent runtime.

### Cross-source search

`createUnifiedSearch(deps)` lets you wire per-source searchers
independently. Sources you omit just emit a warning — fine for a
read-only deployment or a single-backend stack:

```ts
import { createUnifiedSearch } from "@melandlabs/opencontext";

const search = createUnifiedSearch({
	embedQuery: myEmbedder.embedQuery,
	searchRawMessagesAnn: pgAnnSearch,
	searchInsights: insightIndex.search,
	searchKnowledge: ragIndex.search,
});

const { results, warnings } = await search.searchUnifiedMemory({
	userId: "u-1",
	query: "what changed since yesterday?",
	sources: ["memory", "insights", "knowledge"],
	limit: 10,
});
```

### Backend selection

Every backend is selected at boot via `MemoryStoreConfig` — no
abstraction hides what each one can do. Mixing backends is supported:
you can keep raw messages in Postgres while using Chroma as the
vector index, for example.

| Concern      | Backends                                                                      |
| ------------ | ----------------------------------------------------------------------------- |
| Raw messages | SQLite-vec (Tauri / desktop), Postgres (server / daemon), IndexedDB (browser) |
| Vector index | SQLite-vec (default), pgvector, Chroma, IndexedDB                             |
| Embeddings   | OpenAI, Anthropic, Cohere, local via `@melandlabs/opencontext`                |

## Why It Is Different

OpenContext is not a memory library and not a vector DB. It is a
runtime substrate — the `@melandlabs/opencontext` package bundles
contracts, memory-store, retrieval primitives, the loop engine, and
the agent runtime behind one dependency.

| Compared with…                                     | opencontext adds                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A flat vector DB (Pinecone, Weaviate, Qdrant)      | A **temporal graph** — facts have `valid_from` / `valid_until` and get superseded, not just similarity-matched |
| A context/memory library                           | A **runtime, not a library** — HTTP daemon, MCP server, CLI, plus the integrations mesh and the loop engine    |
| Wiring your own agent loop                         | A **separable Loop engine** that schedules when to wake the agent, instead of an LLM loop all the way down     |
| Embedding opencontext just to get its integrations | **Single-package install** — one `pnpm add` gets every capability, no React/Next/Tauri required to use         |

## Provider matrix

| Concern           | Providers                                                                                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vector index      | SQLite-vec (default), pgvector, Chroma, IndexedDB (browser)                                                                                                                                                                                          |
| Embeddings        | OpenAI, Anthropic, Cohere, local via `@melandlabs/opencontext`                                                                                                                                                                                       |
| Raw message store | SQLite-vec, Postgres                                                                                                                                                                                                                                 |
| Web search        | Brave Search                                                                                                                                                                                                                                         |
| Sandboxes         | Native CLI, Claude, Vercel Sandbox                                                                                                                                                                                                                   |
| TTS / STT         | Kokoro (TTS), Whisper (STT)                                                                                                                                                                                                                          |
| Integrations      | Gmail, Outlook, Google Calendar, Google Meet, Slack, Discord, Teams, Telegram, WhatsApp, LinkedIn, Instagram, X, Facebook Messenger, HubSpot, Notion, Asana, Jira, Linear, iMessage, Feishu, Dingtalk, QQbot, Weixin, RSS, Google Drive, Google Docs |

## Architecture

```
                       ┌────────────────────────────┐
                       │     Host application       │   ← your UI, CLI, or daemon
                       │   (a reference app,        │
                       │    or your own embedder)   │
                       └─────────────┬──────────────┘
                                     │
            ┌────────────────────────┴────────────────────────┐
            │   @melandlabs/opencontext                       │
            │   contracts · memory · rag · loop · agent       │
            └────────────────────────┬────────────────────────┘
                                     │
       ┌─────────────────────────────┴─────────────────────────────┐
       │   Storage backends                                        │
       │   sqlite-vec · postgres · indexeddb · chroma · pgvector   │
       └─────────────────────────────┬─────────────────────────────┘
                                     │
       ┌─────────────────────────────┴─────────────────────────────┐
       │   Integrations mesh  (gmail, slack, …)                    │
       └───────────────────────────────────────────────────────────┘
```

Full data-flow diagrams, transport surfaces, and storage backends are
in [`docs/architecture.md`](./docs/architecture.md).

## Used in production

- **[OpenLoomi](https://github.com/melandlabs/openloomi)** — a
  cross-platform desktop "Attention Agent" built on top of OpenContext.
  See the [OpenLoomi README](https://github.com/melandlabs/openloomi)
  for how the same primitives wire up into a real product.

## Documentation

- [`docs/architecture.md`](./docs/architecture.md) — data model, lifecycle, data plane and control plane
- [`docs/philosophy.md`](./docs/philosophy.md) — why this shape
- Each package's `README.md` — API surface, examples, migration notes

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[Apache-2.0](./LICENSE). © 2026 Meland Labs.
