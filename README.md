<div align="center">

# OpenContext

**The context runtime substrate that powers agentic applications.**

A temporal context graph, a four-verb memory API, retrieval primitives,
and a multiple-platform integration mesh — designed to be embedded into any
host process. Battle-tested inside [openloomi](https://github.com/melandlabs/openloomi).

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-F8D52A?logo=apache)](./LICENSE)
[![Status: v0.9.0](https://img.shields.io/badge/status-v0.9.0-yellow)](#status)

</div>

---

## What is OpenContext?

**OpenContext** is the runtime layer that sits underneath an agentic
application. It is not a UI, a chat surface, or a model provider — it
is the glue between the things that make an agent useful: durable
memory, retrieval, context correction, multi-platform connectivity,
scheduled awareness, and the embedding-shaped persistence that holds
all of it together.

## What is it for?

- 🧠 **Give your agent durable memory.** The temporal context graph
  remembers what the user said last week and forgets what they said
  yesterday that turned out to be wrong. No vector-only "throw it all
  into the prompt" hacks.
- 🔌 **Connect the user's world.** A multiple-platform integration mesh
  (Gmail, Slack, Telegram, Linear, Jira, iMessage, Feishu, …) returns
  structured records behind a uniform interface, so you do not have to
  learn multiple APIs.
- ⏰ **Wake up on a schedule.** A small deterministic Loop engine
  decides when to draft a morning brief, summarize the inbox, or
  remind about an unanswered message. LLM calls happen only when there
  is real work.
- 🪶 **Ship a desktop companion in weeks, not months.** All the
  hard parts — auth flows, rate limits, credential rotation, OAuth
  callbacks — live behind the mesh. The host application is just a UI.

## Why OpenContext?

| Compared with…                                   | OpenContext adds                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| A flat vector DB (Pinecone, Weaviate, Qdrant)    | A **temporal graph** — facts have `valid_from` / `valid_until` and get superseded, not just similarity-matched          |
| A memory library                                 | A **runtime, not a library** — HTTP daemon, MCP server, CLI, plus the integrations mesh and the loop engine             |
| Building your own connectors                     | **Multiple first-class platform adapters** with credential rotation, rate-limit handling, and structured-record returns |
| Wiring your own agent loop                       | A **separable Loop engine** that schedules when to call `@opencontext/ai`, instead of an LLM loop all the way down      |
| Embedding openloomi just to get its integrations | **Library-first API surface** — every package is independently published, no React/Next/Tauri required to use           |

## Quick start

```bash
# Install the runtime into your own project
pnpm add @opencontext/memory-store @opencontext/contracts

# Or, build this monorepo from source
git clone https://github.com/melandlabs/opencontext.git
cd OpenContext
pnpm install
pnpm -r build
```

A 30-second example of the four-verb API:

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

## Concepts

Five ideas come up everywhere in the codebase. If you understand these,
the rest is implementation. See
[`docs/architecture.md`](./docs/architecture.md) for the full data
model.

| Concept                    | Package(s)                                                          | One-line summary                                                                         |
| -------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Memory Store**           | `@opencontext/memory-store`                                         | One façade for raw store + vector index + unified search.                                |
| **Temporal Context Graph** | `@opencontext/memory-store`, `@opencontext/ai/memory-consolidation` | Facts carry `valid_from` / `valid_until`; corrections are append-only.                   |
| **Four-Verb API**          | `@opencontext/memory-store`                                         | `remember` / `recall` / `forget` / `improve` — everything else is implementation.        |
| **Loop Engine**            | `@opencontext/loop`, `@opencontext/cron`                            | Deterministic scheduler that wakes up and calls into `@opencontext/ai` only when needed. |
| **Integration Mesh**       | `@opencontext/integrations`, `@opencontext/integrations-runtime`    | Multiple platform adapters behind a uniform `IntegrationRecord` shape.                   |

## Package catalog

| Package                                                                                                                                                                     | Role                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `@opencontext/contracts`                                                                                                                                                    | Boundary types — no React/Next/Tauri allowed. The one every other package depends on.        |
| `@opencontext/memory-store`                                                                                                                                                 | The single façade: raw store + vector index + unified search + four-verb API.                |
| `@opencontext/rag`                                                                                                                                                          | Chunking, embeddings, parsers (PDF/ZIP/text), sqlite-vec + pgvector adapters.                |
| `@opencontext/search`                                                                                                                                                       | Brave Search client + heuristic for "is this a real-time question?".                         |
| `@opencontext/db`                                                                                                                                                           | `batchInsert`, password hashing, agent-goal runtime schema types.                            |
| `@opencontext/sqlite`                                                                                                                                                       | SQLite-vec raw-message manager + schema.                                                     |
| `@opencontext/indexeddb`                                                                                                                                                    | Browser-side mirror of the raw store + memory-graph evolution.                               |
| `@opencontext/storage`                                                                                                                                                      | Generic `StorageProvider` + adapters (local fs, Vercel Blob, in-memory).                     |
| `@opencontext/loop`                                                                                                                                                         | Loop engine leaves (paths, cli-path, preferences).                                           |
| `@opencontext/cron`                                                                                                                                                         | Cron scheduling primitives + SSE stream response.                                            |
| `@opencontext/insights`                                                                                                                                                     | Pure algorithm/filter logic for insight/event management.                                    |
| `@opencontext/audit`                                                                                                                                                        | Structured audit logging to `~/.OpenContext/logs/audit.jsonl`.                               |
| `@opencontext/security`                                                                                                                                                     | Fernet symmetric encryption, URL allowlist/blocklist, pluggable key manager.                 |
| `@opencontext/ai`                                                                                                                                                           | AI SDK wrappers, agent runtime, sandbox providers (native / Claude / Vercel), image + audio. |
| `@opencontext/ai/memory-consolidation`                                                                                                                                      | Offline evidence clustering, relation graphs, semantic draft candidates.                     |
| `@opencontext/ai/mcp`                                                                                                                                                       | Stdio MCP server exposing OpenContext to MCP-capable agent runtimes.                         |
| `@opencontext/integrations`                                                                                                                                                 | Umbrella re-export of all 21 platform adapters.                                              |
| `@opencontext/integrations-runtime`                                                                                                                                         | Dep-free authz + platform-visuals glue.                                                      |
| `@opencontext/integrations/{asana,calendar,channels,…}`                                                                                                                     | 21 platform adapters (Gmail, Slack, Telegram, …).                                            |
| `@opencontext/ui-runtime`                                                                                                                                                   | Tauri platform detection + browser/Tauri filesystem adapters. _(optional peers)_             |
| `@opencontext/hooks`                                                                                                                                                        | React hooks: useLocalStorage, useIsMobile, useOnClickOutside, … _(optional peers)_           |
| `@opencontext/shared`, `@opencontext/env-config`, `@opencontext/api`, `@opencontext/config`, `@opencontext/i18n`, `@opencontext/voice-kokoro`, `@opencontext/voice-whisper` | Shared utilities (cn, errors, locale, TTS/STT, build presets).                               |

## Provider matrix

| Concern           | Providers                                                                                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vector index      | SQLite-vec (default), pgvector, Chroma                                                                                                                                                                                                               |
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
       │   Mesh          @opencontext/integrations (21 platforms)  │
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

## Security

See [`SECURITY.md`](./SECURITY.md). Report vulnerabilities to
**security@OpenContext.dev**.

## License

[Apache-2.0](./LICENSE). © 2026 Meland Labs.
