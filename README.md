<div align="center">

# OpenContext

**The agentic context runtime, powering applications that act on your behalf.**

A temporal context graph, a memory API, retrieval primitives,
and a multi-platform integration mesh — designed to be embedded into any
host process or agents.

<p align="center">
<a href="./README.md">English</a> · <a href="./README-zh.md">简体中文</a>
</p>

[![License](https://img.shields.io/badge/License-Apache_2.0-F8D52A?logo=apache)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/@melandlabs/opencontext.svg)](https://www.npmjs.com/package/@melandlabs/opencontext)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/xkJaJyWcsv)
[![X](https://img.shields.io/badge/X-Follow-000000?logo=x&logoColor=white)](https://x.com/AlloomiAI)

</div>

<div align="center">

⭐ **If you find opencontext useful, please consider giving us a star on GitHub!** It helps more people discover the project and motivates us to keep building. 🙏

[![GitHub Repo stars](https://img.shields.io/github/stars/melandlabs/opencontext?style=social&label=Star)](https://github.com/melandlabs/opencontext)

</div>

---

## What is OpenContext?

**OpenContext** is the agentic context runtime that sits underneath an agentic
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
const hits = await store.search({
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

### 3. Manage memory from the CLI

The same memory store the HTTP and MCP daemons talk to is reachable from
the command line. `add` writes a single raw message straight to the active
manager — no LLM roundtrip — and `search` runs a unified read across
memory, insights, and knowledge.

```bash
# Write a fact (auto-fills messageId, platform="cli", timestamp=now)
opencontext add --user alice --text "Rust achieves memory safety without GC"

# Write with full provenance for later consolidation
opencontext add \
  --user alice --bot general \
  --text "Discussed Q4 roadmap with the team" \
  --source "meeting://2026-08-20" --kind experience \
  --tag topic=roadmap --tag team=eng

# Plain hybrid search (RRF across memory + insights + knowledge)
opencontext search --user alice --query "memory safety" --k 5

# Inspect what would have been sent to the LLM, no synthesis call
opencontext search --user alice --query "what did we chat about last weekend" --context-only

# Script-friendly JSON
opencontext search --user alice --query "x" --json | jq '.results[].id'
```

`add` accepts `--user` (default `"default"`), `--bot` (default `"default"`),
`--platform`, `--channel`, `--person`, `--source`, `--kind`, `--at`,
and repeatable `--tag key=value`. `search` accepts `--mode {auto|lex|sem}`,
`--k`, `--threshold`, repeatable `--bot` / `--kind`, `--since` / `--until`,
and `--explain` to surface reasoning + warnings alongside the hits.

Run `opencontext <command> --help` for the full flag list. See the
[Getting Started tutorial](./docs/tutorials/00-getting-started.md#managing-memory-from-the-cli)
for the full flag reference and worked examples.

### 4. Run the HTTP daemon from npm

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

### 5. Wire the MCP server into Claude Desktop / Cursor

```bash
opencontext mcp \
  --embedding-provider local \
  --memory-backend sqlite-vec
```

### 6. Use with DeepSeek Harness (DSH)

OpenContext is available as a DSH plugin that gives any DSH agent durable memory and retrieval-augmented context:

```bash
# Install the plugin from npm
dsh plugin --profile web add dsh-opencontext

# Confirm it's mounted
dsh --profile web --dump-config | grep dsh-opencontext
#   ... should contain `id: dsh-opencontext`

# Start DSH web and verify
dsh web
#   Visit http://127.0.0.1:3080/plugins and confirm dsh-opencontext shows "Enabled"
```

The plugin exposes 16 `oc_*` tools (e.g., `oc_search`, `oc_remember`, `oc_memory_list`) and automatically:
- Runs a recall waterfall on each turn to inject relevant historical context
- Captures user messages into durable memory
- Summarizes sessions at natural breakpoints (opt-in)

See [`plugins/dsh-opencontext/README.md`](./plugins/dsh-opencontext/README.md) for configuration options and the full tool reference.

### 7. Diagnose the install

```bash
opencontext doctor             # human-readable health checks
opencontext doctor --json      # CI-friendly { ok, exit, results } envelope
opencontext doctor --section memory-store
```

`doctor` is read-only and exits `0` on a healthy install. It scans nine
sections (`runtime`, `filesystem`, `loop`, `memory-store`, `embedding`,
`policies`, `audit`, `security`, `integrations`) and reports pass /
warn / fail for each. No auto-fix in v1.

**Next:** [Tutorials](./docs/tutorials/README.md) — get started, user guide, developer guide, advanced patterns, and best practices

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

### Tutorials (Start Here)

- [`docs/tutorials/README.md`](./docs/tutorials/README.md) — **Tutorial index and learning path**
- [`docs/tutorials/00-getting-started.md`](./docs/tutorials/00-getting-started.md) — Get up and running in 5 minutes
- [`docs/tutorials/01-user-guide.md`](./docs/tutorials/01-user-guide.md) — Understand the four verbs and temporal memory
- [`docs/tutorials/02-developer-guide.md`](./docs/tutorials/02-developer-guide.md) — Integrate OpenContext into your app
- [`docs/tutorials/03-advanced-usage.md`](./docs/tutorials/03-advanced-usage.md) — Production patterns and advanced features
- [`docs/tutorials/04-best-practices.md`](./docs/tutorials/04-best-practices.md) — Tips and common pitfalls
- [`docs/tutorials/use-cases/README.md`](./docs/tutorials/use-cases/README.md) — Real-world use cases: personal assistant, support agent, research tracker

### Architecture & Design

- [`docs/architecture.md`](./docs/architecture.md) — data model, lifecycle, data plane and control plane
- [`docs/philosophy.md`](./docs/philosophy.md) — why this shape
- Each package's `README.md` — API surface, examples, migration notes

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[Apache-2.0](./LICENSE). © 2026 Meland Labs.
