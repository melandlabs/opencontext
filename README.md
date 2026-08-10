<div align="center">

# OpenContext

**The context runtime substrate that powers agentic applications.**

A temporal context graph, a memory API, retrieval primitives,
and a multiple-platform integration mesh — designed to be embedded into any
host process. Battle-tested inside [openloomi](https://github.com/melandlabs/openloomi).

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
application. It is not a UI, a chat surface, or a model provider —
it is the glue between the things that make an agent useful: durable
memory, retrieval, context correction, multi-platform connectivity,
scheduled awareness, and the embedding-shaped persistence that holds
all of it together.

→ Read [`docs/architecture.md`](./docs/architecture.md) for the full
data model, the lifecycle of a fact, and the transport surface map.

## Features

|     | Capability                                                                      | What it does                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🧠  | **[Temporal Context Graph](./docs/architecture.md#the-temporal-context-graph)** | A directed acyclic graph where every fact has `valid_from` / `valid_until`. Supersession, contradiction, and merge are first-class edges — corrections are append-only, not destructive.                |
| 🔌  | **[Platform Integration Mesh](./packages/integrations)**                        | One uniform `IntegrationRecord` shape across Gmail, Slack, Telegram, Linear, Jira, iMessage, Feishu, Weixin, … — credential rotation, rate-limit handling, and reconnect logic live behind the adapter. |
| ⏰  | **[Deterministic Loop Engine](./packages/loop)**                                | A scheduler that wakes up, decides whether there is real work, and only then calls into `@opencontext/ai`. LLM calls are not the foundation — they are the last step.                                   |
| 🔍  | **[Retrieval Primitives](./packages/rag)**                                      | Chunking, embeddings, parsers (PDF/ZIP/text), sqlite-vec + pgvector + Chroma adapters. Mix backends without rewriting the recall pipeline.                                                              |
| 🤖  | **[Agent Runtime](./packages/ai)**                                              | AI SDK wrappers, sandbox providers (native / Claude / Vercel), MCP server, memory-consolidation job, image + audio generation.                                                                          |
| 🪶  | **[Library-First API](./packages/contracts)**                                   | Drop any single package into your own app via `pnpm add @opencontext/<x>`. No React, Next, or Tauri required.                                                                                           |
| 🛡️  | **[Audit + Encrypted Storage](./packages/audit)**                               | Structured audit logging to `~/.opencontext/logs/audit.jsonl`, Fernet symmetric encryption for secrets, URL allowlist/blocklist for outbound calls.                                                     |

## Quick Start

There are four ways to get opencontext into your project. Pick the one
that matches what you're building.

### 1. Embed the runtime into your own app

```bash
pnpm add @opencontext/memory-store @opencontext/contracts
```

A 30-second example of the memory API:

```ts
import { createMemoryStore } from "@opencontext/memory-store";

const store = createMemoryStore({
	db: { type: "sqlite-vec", path: "./memory.db" },
	vector: { provider: "openai", model: "text-embedding-3-small" },
});

await store.remember({
	content: "User prefers dark mode in all tools",
	scope: "user:42",
});

const hits = await store.recall({
	query: "What does the user prefer?",
	topK: 5,
});

await store.improve({
	target: hits[0].id,
	kind: "supersedes",
	evidence: "User toggled to light mode in settings on 2026-08-10",
});

await store.forget({ id: hits[0].id, reason: "superseded" });
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
npx -y @opencontext/memory-store memory-http --host 127.0.0.1 --port 7421
curl http://127.0.0.1:7421/health
```

### 4. Wire the MCP server into Claude Desktop / Cursor

Add to your `claude_desktop_config.json` (or Cursor → Settings → MCP):

```json
{
	"mcpServers": {
		"opencontext-memory": {
			"command": "npx",
			"args": ["-y", "@opencontext/memory-store", "memory-mcp"],
			"env": {
				"DATABASE_URL": "postgres://user:pass@host:5432/opencontext"
			}
		}
	}
}
```

Four tools become available inside the editor: `memory.health`,
`memory.searchUnified`, `memory.writeRawMessage`,
`memory.getRawMessage`.

## Common usage patterns

### The memory API

`@opencontext/memory-store` exposes one factory and four verbs. The
verbs are the minimum set that covers the full lifecycle of a fact —
everything else is implementation. See
[`packages/memory-store/README.md`](./packages/memory-store/README.md)
for the full configuration matrix and recipes.

| Verb       | Use it for                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| `remember` | Ingest and re-ingest. Idempotent on `(scope, content-hash)`.                                                |
| `recall`   | Unified search across semantic, lexical, graph, and recency sub-queries.                                    |
| `improve`  | Append a supersession / contradiction / merge edge. The original node is never hard-deleted.                |
| `forget`   | Soft-delete via `valid_until = now`. GDPR right-to-erasure is handled by an out-of-band compliance process. |

### Temporal queries (time travel)

Every node in the context graph has `valid_from` and `valid_until`
fields. A recall can ask for facts as-of a particular timestamp by
filtering `valid_from ≤ t < valid_until` — useful for "what did the
user believe last Tuesday?" or "which preference is current?".

```ts
const asOf = await store.recall({
	query: "user's preferred working hours",
	scope: "user:42",
	asOf: new Date("2026-08-01"),
});
```

### MCP server

`@opencontext/memory-store/mcp` exposes the same operations over
stdio — usable from Claude Desktop, Cursor, Claude Code, Codex CLI,
or any MCP-capable agent runtime. The CLI entry point is
`opencontext-memory-mcp`.

### Cross-source search

`createUnifiedSearch(deps)` lets you wire per-source searchers
independently. Sources you omit just emit a warning — fine for a
read-only deployment or a single-backend stack:

```ts
import { createUnifiedSearch } from "@opencontext/memory-store/unified-search";

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
| Embeddings   | OpenAI, Anthropic, Cohere, local via `@opencontext/rag/universal-embeddings`  |

## Why It Is Different

OpenContext is not a memory library and not a vector DB. It is a
runtime substrate — every package is independently versioned, has a
single responsibility, and consumes only `@opencontext/contracts`
from the boundary layer.

| Compared with…                                   | opencontext adds                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| A flat vector DB (Pinecone, Weaviate, Qdrant)    | A **temporal graph** — facts have `valid_from` / `valid_until` and get superseded, not just similarity-matched     |
| A context/memory library                         | A **runtime, not a library** — HTTP daemon, MCP server, CLI, plus the integrations mesh and the loop engine        |
| Wiring your own agent loop                       | A **separable Loop engine** that schedules when to call `@opencontext/ai`, instead of an LLM loop all the way down |
| Embedding openloomi just to get its integrations | **Library-first API surface** — every package is independently published, no React/Next/Tauri required to use      |

## Provider matrix

| Concern           | Providers                                                                                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vector index      | SQLite-vec (default), pgvector, Chroma, IndexedDB (browser)                                                                                                                                                                                          |
| Embeddings        | OpenAI, Anthropic, Cohere, local via `@opencontext/rag/universal-embeddings`                                                                                                                                                                         |
| Raw message store | SQLite-vec, Postgres                                                                                                                                                                                                                                 |
| Web search        | Brave Search                                                                                                                                                                                                                                         |
| Sandboxes         | Native CLI, Claude, Vercel Sandbox                                                                                                                                                                                                                   |
| TTS / STT         | Kokoro (TTS), Whisper (STT)                                                                                                                                                                                                                          |
| Integrations      | Gmail, Outlook, Google Calendar, Google Meet, Slack, Discord, Teams, Telegram, WhatsApp, LinkedIn, Instagram, X, Facebook Messenger, HubSpot, Notion, Asana, Jira, Linear, iMessage, Feishu, Dingtalk, QQbot, Weixin, RSS, Google Drive, Google Docs |

## Architecture at a glance

```
                       ┌────────────────────────────┐
                       │     Host application       │   ← your UI, CLI, or daemon
                       │   (openloomi, an example,  │
                       │    or your own embedder)   │
                       └─────────────┬──────────────┘
                                     │
            ┌────────────────────────┴────────────────────────┐
            │   Boundary:  @opencontext/contracts  ·  api     │
            └────────────────────────┬────────────────────────┘
                                     │
       ┌─────────────────────────────┴─────────────────────────────┐
       │   Memory substrate                                         │
       │   @opencontext/memory-store · rag · sqlite · indexeddb     │
       └─────────────────────────────┬──────────────────────────────-┘
                                     │
       ┌─────────────────────────────┴─────────────────────────────┐
       │   Engine        @opencontext/loop · cron · insights       │
       │   Agent runtime @opencontext/ai                            │
       │   Mesh          @opencontext/integrations (21 adapters)   │
       └────────────────────────────────────────────────────────────┘
```

Full data-flow diagrams, transport surfaces, and storage backends are
in [`docs/architecture.md`](./docs/architecture.md).

## Documentation

- [`docs/architecture.md`](./docs/architecture.md) — data model, lifecycle, transport surfaces
- [`docs/philosophy.md`](./docs/philosophy.md) — why this shape, why this split
- [`docs/split-from-openloomi.md`](./docs/split-from-openloomi.md) — history of the carve-out
- Each package's `README.md` — API surface, examples, migration notes

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Every change needs a
changeset entry — run `pnpm changeset` after editing any package.

## License

[Apache-2.0](./LICENSE). © 2026 Meland Labs.
