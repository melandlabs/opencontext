# opencontext

> An open-source runtime substrate for agentic applications.
> A temporal context graph, a four-verb memory API, retrieval-augmented
> generation primitives, and a 27-platform integration mesh — designed
> to be embedded into any host process, battle-tested inside
> [openloomi](https://github.com/melandlabs/openloomi).

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Monorepo: pnpm](https://img.shields.io/badge/pnpm-10.14-orange.svg)](https://pnpm.io)
[![Node: 20](https://img.shields.io/badge/node-20-green.svg)](https://nodejs.org)
[![Status: v0.10.0](https://img.shields.io/badge/status-v0.10.0-yellow.svg)](#status)

## What is opencontext?

**opencontext** is the runtime layer that an agentic application sits on top
of. It is not a UI, a chat surface, or a model provider — it is the
glue between the things that make an agent useful: durable memory,
retrieval, context correction, multi-platform connectivity, scheduled
awareness, and the embedding-shaped persistence that holds all of it
together.

It is published as a pnpm monorepo of focused packages (`@opencontext/*`)
that you can install individually. Each package is small, independently
versioned, and has a single responsibility. Most packages have **zero**
runtime dependencies on each other beyond a handful of well-defined
boundary types (`@opencontext/contracts`).

## Why opencontext exists

Three observations shaped it:

1. **Stateless LLMs are not enough.** Without a memory layer, an agent
   forgets what you told it five minutes ago, repeats itself, and cannot
   personalize. The naïve fix — "throw context into the prompt" —
   collapses under its own weight past a few thousand tokens.
2. **Static vector search is not enough either.** A flat similarity index
   loses the temporal and relational structure of real memory: that you
   said *X* yesterday, that *X* contradicts *Y* you said last week,
   that *Z* is a more recent and more authoritative replacement. Good
   recall needs a graph.
3. **One integration per platform is not enough.** A useful agent reaches
   into the user's world — email, calendar, chat, documents, ticketing
   systems, social surfaces. Each platform has its own quirks and each
   deserves a first-class adapter behind a uniform interface.

The packages in this repo address each of those problems in isolation,
and then wire them together in `@opencontext/memory-store` and
`@opencontext/ai`.

## Core concepts

Five ideas come up everywhere in the codebase. If you understand these,
the rest is implementation.

### 1. The Memory Store

A single façade (`@opencontext/memory-store`) that gives you:

- a **raw message store** (durable, append-mostly, browser or server),
- a **vector index** (SQLite-vec, pgvector, or Chroma),
- a **unified search** that ranks across raw text, semantic similarity,
  knowledge-graph facts, and recent insights in one call.

```ts
import { createMemoryStore } from "@opencontext/memory-store";

const store = createMemoryStore({
  db: { type: "sqlite-vec", path: "./memory.db" },
  vector: { provider: "openai", model: "text-embedding-3-small" },
});

// remember — durable, indexed, graph-aware
await store.remember({
  content: "User prefers dark mode in all tools",
  source: "settings-sync",
  scope: "user:42",
});

// recall — cross-source, ranked
const hits = await store.recall({
  query: "What does the user prefer?",
  topK: 5,
});
```

### 2. The Temporal Context Graph

Inside the memory store, facts are not just rows. Each `remember()` call
becomes a node, and corrections or supersedes become edges. The graph
records **when** a fact was true, **when** it stopped being true, and
**why** — so a recall that happens months later can ask "what was true
as of last Tuesday?" rather than only "what is currently true?".

This is the same problem temporal databases have solved for decades,
applied to natural-language facts. See
[`docs/architecture.md`](./docs/architecture.md#the-temporal-context-graph)
for the data model.

### 3. The Four-Verb API

Every persistent operation against memory is one of four verbs:

| Verb | Meaning |
| --- | --- |
| `remember` | Persist a fact, message, or relationship. Idempotent on `(scope, content-hash)`. |
| `recall` | Retrieve facts relevant to a query, scoped to a time window and a graph traversal depth. |
| `forget` | Soft-remove a fact. The fact remains in cold storage with a tombstone so future corrections can be traced. Hard-delete is reserved for compliance. |
| `improve` | Apply a correction, supersession, or merge based on new evidence. |

The verbs are deliberately small. Everything else — chunking, embedding,
graph traversal, ranking — is an implementation detail of a verb.

### 4. The Loop Engine

`@opencontext/loop` is the part of the runtime that wakes up on a
schedule and decides whether there is anything worth doing — drafting a
morning brief, summarizing yesterday's inbox, reminding the user about
an unanswered message. It is **deliberately not** an LLM-driven agent
loop; it is a small, deterministic scheduler that calls into
`@opencontext/ai` only when there is real work.

This separation matters. Most "agent runtimes" are LLM loops all the way
down. When the LLM call fails, you do not know whether the bug is in the
prompt, the tool, or the orchestration. opencontext's Loop is small
enough that you can read it in one sitting, and big enough to host
arbitrary side-effects.

### 5. The Integration Mesh

`@opencontext/integrations` (with 21 platform-specific sub-packages)
exposes a uniform adapter interface over: Gmail, Google Calendar,
Google Meet, Slack, Discord, Microsoft Teams, Telegram, WhatsApp,
LinkedIn, Instagram, X (Twitter), Facebook Messenger, HubSpot, Notion,
Asana, Jira, Linear, iMessage, Feishu, Dingtalk, QQbot, Weixin, RSS,
Google Drive, Google Docs, and Jira.

The mesh is the surface area where openloomi-style "connect your tools"
experiences live. Adapters return structured records (not raw API
shapes) so callers do not have to learn 27 APIs.

## Package catalog

### Core runtime

| Package | Role |
| --- | --- |
| `@opencontext/contracts` | Boundary types shared between runtime and host apps (no React/Next/Tauri). |
| `@opencontext/memory-store` | The single façade: raw store + vector index + unified search. |
| `@opencontext/rag` | Chunking, embeddings, parsers (PDF/ZIP/text), sqlite-vec + pgvector adapters. |
| `@opencontext/search` | Web search client (Brave) + a heuristic for "is this a real-time question?". |
| `@opencontext/db` | `batchInsert`, password hashing, agent-goal runtime schema types. |
| `@opencontext/sqlite` | SQLite-vec raw-message manager + schema. |
| `@opencontext/indexeddb` | Browser-side raw-message storage, embedding helpers, extractor, memory-graph evolution/lifecycle/governance. |
| `@opencontext/storage` | Generic key/value `StorageProvider` + adapters (local fs, Vercel Blob, in-memory). |
| `@opencontext/insights` | Pure algorithm/filter logic for insight/event management. |
| `@opencontext/audit` | Structured audit logging to `~/.opencontext/logs/audit.jsonl`. |
| `@opencontext/security` | Fernet symmetric encryption, URL allowlist/blocklist, pluggable key manager. |

### Engine

| Package | Role |
| --- | --- |
| `@opencontext/loop` | Leaf filesystem + preferences for the Loop engine. |
| `@opencontext/cron` | Cron scheduling primitives + SSE stream response. |

### AI / Agent

| Package | Role |
| --- | --- |
| `@opencontext/ai` | AI SDK wrappers, agent runtime, sandbox providers (native / Claude / Vercel), image + audio. |
| `@opencontext/ai/memory-consolidation` | Offline evidence clustering, relation graphs, semantic draft candidates. |
| `@opencontext/ai/mcp` | Stdio MCP server exposing opencontext to MCP-capable agent runtimes. |

### Integrations

| Package | Role |
| --- | --- |
| `@opencontext/integrations` | Umbrella re-export of every platform adapter. |
| `@opencontext/integrations-runtime` | Dep-free authorization-error + platform-visuals glue. |
| `@opencontext/integrations/{asana,calendar,channels,composio,…}` | 21 platform-specific adapters (Gmail, Slack, Telegram, …). |

### UI-side (optional peers)

| Package | Role |
| --- | --- |
| `@opencontext/ui-runtime` | Tauri platform detection + browser/Tauri filesystem adapters. |
| `@opencontext/hooks` | React hooks: useLocalStorage, useIsMobile, useOnClickOutside, … |

### Shared utilities

| Package | Role |
| --- | --- |
| `@opencontext/shared` | `cn()`, UUID, sanitize, formatBytes, errors, types, tokens, locale, platform, soul. |
| `@opencontext/env-config` | Env/deployment-mode/Tauri-path constants. |
| `@opencontext/api` | `fetchApi<T>()` HTTP wrapper + `ApiError`. |
| `@opencontext/config` | Shared tsup preset, ESLint preset, tsconfig preset. |
| `@opencontext/i18n` | Locale message bundles (`en-US`, `zh-Hans`). |
| `@opencontext/voice-kokoro` | Kokoro TTS provider. |
| `@opencontext/voice-whisper` | Whisper STT provider. |

## Architecture diagram

```
                          ┌─────────────────────────────┐
                          │       Host application       │
                          │   (openloomi, an example,    │
                          │    or your own integration)  │
                          └──────────────┬───────────────┘
                                         │
                                         ▼
        ┌──────────────────────────────────────────────────────────┐
        │                    Boundary layer                        │
        │           @opencontext/contracts   @opencontext/api      │
        └──────────────────────────────────────────────────────────┘
                                         │
                                         ▼
        ┌──────────────────────────────────────────────────────────┐
        │               Memory substrate                            │
        │                                                            │
        │   @opencontext/memory-store                               │
        │     ├── raw-message-store   (sqlite-vec / postgres / …)   │
        │     ├── vector-index        (sqlite-vec / pgvector / …)   │
        │     ├── unified-search      (semantic + graph + recency)  │
        │     ├── graph-write-policy                                 │
        │     └── graph-correction-policy                            │
        │                                                            │
        │   @opencontext/rag        (chunking + embeddings + parser) │
        │   @opencontext/sqlite     (sqlite-vec raw-message)        │
        │   @opencontext/indexeddb  (browser-side mirror)            │
        └──────────────────────────────────────────────────────────┘
                                         │
                                         ▼
        ┌──────────────────────────────────────────────────────────┐
        │               Engine + scheduling                         │
        │   @opencontext/loop      @opencontext/cron                │
        │   @opencontext/insights  @opencontext/audit               │
        └──────────────────────────────────────────────────────────┘
                                         │
                                         ▼
        ┌──────────────────────────────────────────────────────────┐
        │               Agent runtime                               │
        │   @opencontext/ai                                            │
        │     ├── agent (native-cli / native-runner / runtime)      │
        │     ├── memory-consolidation                              │
        │     ├── mcp  (stdio server: setup / search / kb / …)     │
        │     ├── sandbox  (native / claude / vercel)              │
        │     ├── image-gen / audio                                 │
        │     └── runtime-instructions                              │
        └──────────────────────────────────────────────────────────┘
                                         │
                                         ▼
        ┌──────────────────────────────────────────────────────────┐
        │               Integration mesh                            │
        │   @opencontext/integrations                                │
        │     ├── @opencontext/integrations-gmail                    │
        │     ├── @opencontext/integrations-slack                    │
        │     ├── @opencontext/integrations-telegram                 │
        │     ├── … (21 platforms)                                   │
        │     └── @opencontext/integrations-runtime                  │
        │           (authz + platform-visuals glue)                  │
        └──────────────────────────────────────────────────────────┘
```

## Getting started

```bash
# 1. Install dependencies
pnpm install

# 2. Build everything
pnpm -r build

# 3. Run the type checker
pnpm -r typecheck

# 4. Run the test suite
pnpm -r test
```

To use opencontext in your own project, install the packages you need:

```bash
pnpm add @opencontext/memory-store @opencontext/contracts
```

…and follow the README of each package. The
[`CONTRIBUTING.md`](./CONTRIBUTING.md) document covers how to add new
packages, run the linter, and prepare a release.

## Provider matrix

| Concern | Providers |
| --- | --- |
| Vector index | SQLite-vec (default), pgvector, Chroma |
| Embeddings | OpenAI, Anthropic, Cohere, local models via `@opencontext/rag/universal-embeddings` |
| Raw message store | SQLite-vec, Postgres |
| Web search | Brave Search |
| Sandboxes | Native CLI, Claude, Vercel Sandbox |
| TTS / STT | Kokoro (TTS), Whisper (STT) |
| Integrations | Gmail, Outlook, Google Calendar, Google Meet, Slack, Discord, Teams, Telegram, WhatsApp, LinkedIn, Instagram, X, Facebook Messenger, HubSpot, Notion, Asana, Jira, Linear, iMessage, Feishu, Dingtalk, QQbot, Weixin, RSS, Google Drive, Google Docs |

## Documentation

- [`docs/architecture.md`](./docs/architecture.md) — data model, lifecycle, transport surfaces
- [`docs/philosophy.md`](./docs/philosophy.md) — why this split, why this shape
- [`docs/split-from-openloomi.md`](./docs/split-from-openloomi.md) — history of the carve-out
- Each package's `README.md` — API surface, examples, and migration notes

## Status

opencontext is **v0.10.0**. The internal API has stabilized enough to
publish, and the major-version interface (`createMemoryStore()`,
`remember()`, `recall()`, `forget()`, `improve()`) is unlikely to
change in incompatible ways before v1.0. Sub-packages under
`@opencontext/ai/*` and `@opencontext/integrations/*` are still evolving.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). All changes require a
changeset entry. Run `pnpm changeset` after editing any package.

## Security

See [`SECURITY.md`](./SECURITY.md). Report vulnerabilities to
**security@opencontext.dev**.

## Code of conduct

See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## License

[Apache-2.0](./LICENSE). © 2026 Meland Labs.

## Acknowledgements

The four-verb surface and the temporal-graph framing in this README
were influenced — **structurally only** — by the open-source memory
projects [graphiti](https://github.com/getzep/graphiti),
[mem0](https://github.com/mem0ai/mem0),
[letta](https://github.com/letta-ai/letta), and
[cognee](https://github.com/topoteretes/cognee). No prose in this
repository is copied from those projects. The four-verb semantics, the
temporal correction model, the integration-mesh framing, and every line
of documentation are original to this project.