# Architecture

This document describes how the packages in this monorepo fit together
at runtime. It is meant to be read alongside the root
[`README.md`](../README.md) — that one explains _what_ opencontext is,
this one explains _how_ it works.

## Runtime substrate overview

There are five distinct layers:

1. **Boundary** — `@melandlabs/opencontext` and `@melandlabs/opencontext`.
   These are the only packages that host applications are required to
   know about. They expose types and a thin HTTP client; they have no
   runtime side-effects.
2. **Memory substrate** — `@melandlabs/opencontext`, `@melandlabs/opencontext`,
   `@melandlabs/opencontext`, `@melandlabs/opencontext`, `@melandlabs/opencontext`,
   `@melandlabs/opencontext`. These own durable state and the operations
   that mutate or read it.
3. **Engine** — `@melandlabs/opencontext`, `@melandlabs/opencontext`,
   `@melandlabs/opencontext`, `@melandlabs/opencontext`. These decide _when_ and
   _whether_ to do work, and they record what was done.
4. **Agent runtime** — `@melandlabs/opencontext`. This is where LLM calls,
   tool execution, sandboxing, and image/audio generation live. It is the
   only layer that talks to model providers.
5. **Integration mesh** — `@melandlabs/opencontext` and its 21
   platform sub-packages. Each one owns the credential flow, the rate
   limits, the structured-record shape, and the reconnect logic for one
   external system.

These layers compose top-down. The boundary layer depends on nothing.
The memory substrate depends on the boundary types. The engine depends
on the memory substrate. The agent runtime depends on the memory
substrate and the integrations. The integrations depend on the boundary
types.

No layer reaches sideways.

## The memory lifecycle

A fact moves through five phases. Each phase is a method on
`@melandlabs/opencontext`:

```
  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
  │ ingest   │ →  │ index    │ →  │ recall   │ →  │ correct  │ →  │ retire   │
  └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
   remember()      (chunk +       recall()       improve()         forget()
                    embed)
```

### Ingest (`remember`)

A caller submits a `RawMessage` — a string with metadata. The memory
store:

1. Normalises the payload (deduplicates whitespace, strips zero-width
   characters, normalises Unicode).
2. Computes a content hash so duplicate ingests are idempotent on
   `(scope, content-hash)`.
3. Persists the raw message to the raw-message store (SQLite-vec by
   default; postgres is supported).
4. Schedules chunking + embedding in the background (see
   `chunkAndEmbed` in `@melandlabs/opencontext`).
5. Appends a node to the temporal context graph with `valid_from = now`
   and `valid_until = null`.

### Index (background)

The chunker (`@melandlabs/opencontext/chunking`) splits the raw message into
overlapping windows. Each window is embedded with the configured
provider (`@melandlabs/opencontext/universal-embeddings`) and the resulting
vectors are written to the vector index. Edges between the original
message node and its chunk nodes are recorded in the graph.

### Recall

A query arrives. The recall pipeline runs four sub-queries in parallel
and merges the results:

- **Semantic**: vector similarity search over the index.
- **Lexical**: substring + tag match over raw messages.
- **Graph**: BFS from the most recent N nodes within the requested
  scope, depth ≤ `traversalDepth`.
- **Recency**: prefer newer `valid_from` timestamps when ranking is
  ambiguous.

The unified result is a `RecallResult[]` ordered by combined score.
The merge logic is pluggable via `UnifiedSearchDeps` in
`@melandlabs/opencontext`'s config.

### Correct (`improve`)

A caller submits evidence that a fact is wrong, superseded, or merged
with another fact. The memory store:

1. Verifies the caller has the appropriate permission via
   `memory-graph-correction-policy`.
2. Either marks the target node as `valid_until = now` (supersession),
   appends a correction edge (correction), or merges two nodes into a
   new one (merge).
3. Re-emits the affected chunks for re-embedding if the content
   changed meaningfully.

The original node is never hard-deleted. Corrections are append-only.

### Retire (`forget`)

Soft-delete. The node's `valid_until` is set to `now` and a tombstone
edge is added. The raw bytes remain on disk for compliance (GDPR right-
to-erasure is handled by a separate, out-of-band process). Hard-delete
is reserved for that compliance process and is not exposed via the
public API.

## The temporal context graph

The graph is a directed acyclic graph where each node represents a fact
and each edge represents a relationship between two facts. Three edge
types are supported:

| Edge type     | Meaning                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `extends`     | The target adds detail to the source. Both remain valid.                                                          |
| `supersedes`  | The target is more recent and more authoritative. The source's `valid_until` is set to the target's `valid_from`. |
| `contradicts` | The target conflicts with the source. Both remain valid; callers see both and decide.                             |

Nodes carry five temporal fields:

- `created_at` — when the node was first added to the graph.
- `valid_from` — when the fact the node represents became true.
- `valid_until` — when the fact stopped being true (null = still true).
- `observed_at` — when the caller noticed this fact.
- `expired_at` — when the node was explicitly retired.

A recall can ask for facts as-of a particular timestamp by filtering
`valid_from ≤ t < valid_until`. This is what makes the graph _temporal_
rather than just _versioned_.

## Data flow diagrams

### Ingest

```
caller
  │
  ▼
store.remember(RawMessage)
  │
  ├─→ raw-message-store.append()        (sqlite-vec / postgres)
  │
  └─→ background: chunkAndEmbed()
        │
        ├─→ chunker.split()              (@melandlabs/opencontext/chunking)
        │
        └─→ embedder.embed()             (@melandlabs/opencontext/universal-embeddings)
              │
              └─→ vector-index.upsert()   (sqlite-vec / pgvector / chroma)
```

### Recall

```
caller
  │
  ▼
store.recall({ query, scope, topK, traversalDepth })
  │
  ├─→ vector-index.search(query, topK)         (semantic)
  │
  ├─→ raw-message-store.textSearch(query)      (lexical)
  │
  ├─→ graph.traverse(scope, depth)              (relational)
  │
  └─→ merge + rank → RecallResult[]
```

### Integration write

```
loop tick → agent.run()
                │
                ▼
            @melandlabs/opencontext/agent
                │
                ├─→ tool: integrations-gmail.send(...)
                │         │
                │         ├─→ auth-manager.ensureToken()
                │         ├─→ rate-limiter.wait()
                │         └─→ platform-API.POST(...)
                │
                └─→ audit.log(command_exec)
```

## Storage backends

| Concern             | Backend     | Where                                                                          |
| ------------------- | ----------- | ------------------------------------------------------------------------------ |
| Raw messages        | SQLite-vec  | `@melandlabs/opencontext` (Tauri default), `@melandlabs/opencontext` (browser) |
| Raw messages        | Postgres    | `@melandlabs/opencontext/postgres-raw-message-factory`                         |
| Vector index        | SQLite-vec  | `@melandlabs/opencontext/sqlite-vector-index`                                  |
| Vector index        | pgvector    | `@melandlabs/opencontext/pgvector-store`                                       |
| Vector index        | Chroma      | `@melandlabs/opencontext/chroma-memory-index`                                  |
| Vector index        | IndexedDB   | `@melandlabs/opencontext/embedding`                                            |
| Blobs / attachments | Local fs    | `@melandlabs/opencontext/local-fs`                                             |
| Blobs / attachments | Vercel Blob | `@melandlabs/opencontext/vercel-blob`                                          |

The storage backend is chosen at boot via `MemoryStoreConfig`. Mixing
backends is supported: a deployment can keep raw messages in Postgres
while using Chroma as the vector index, for example.

## Transport surfaces

`@melandlabs/opencontext` exposes the runtime over four surfaces:

| Surface      | Module                                                                            | Purpose                                                                                                         |
| ------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Programmatic | `@melandlabs/opencontext`                                                         | Direct import from a Node/Bun/Deno process.                                                                     |
| HTTP daemon  | `@melandlabs/opencontext/http`                                                    | Hono server on `:7421` (`GET /health`, `POST /v1/search`, `POST /v1/raw-messages`, `GET /v1/raw-messages/:id`). |
| MCP server   | `@melandlabs/opencontext/mcp`                                                     | Stdio MCP server exposing `memory_search`, `memory_recall`, `memory_forget` to MCP-capable agent runtimes.      |
| CLI          | `opencontext` (shipped via `@melandlabs/opencontext`; subcommands: `mcp`, `http`, `doctor`) | Run the MCP (`mcp`, default) or HTTP (`http`) daemon from a terminal, or run health checks (`doctor`) across the facade's subsystems.                                           |

The HTTP and MCP surfaces are thin wrappers around the programmatic
API. They share types via `@melandlabs/opencontext` and never reimplement
business logic.

### `opencontext doctor` — read-only health checks

The `doctor` subcommand runs nine read-only check sections against the
local install (`runtime`, `filesystem`, `loop`, `memory-store`,
`embedding`, `policies`, `audit`, `security`, `integrations`) and
reports `ok` / `warn` / `fail` for each. It is non-mutating by design
(no `--fix`): the PowerContext pattern, and a safe one when an install
is already broken.

```bash
opencontext doctor                          # human-readable; warns + fails only
opencontext doctor --json                   # stable { ok, exit, results } envelope
opencontext doctor --section memory-store   # filter to one section
opencontext doctor --deep                   # opt-in real memory-store read probe
opencontext doctor --user alice             # probe policies as a specific user
```

Exits `0` when no check fails, `1` otherwise — warnings do not affect
the exit code, so the `--json` envelope plus `jq -e '.ok'` is a stable
CI gate.

## Cross-process contracts

Two contracts are load-bearing across process boundaries:

- `RawMessage` — the wire format between a caller and the HTTP daemon.
  Defined in `@melandlabs/opencontext/contracts`. Decoupled from
  `@melandlabs/opencontext` browser globals so it can be imported in
  Node, Bun, and the browser alike.
- `IntegrationId` — the 27-platform enum used everywhere an integration
  is referenced. Defined in `@melandlabs/opencontext/contracts/integration-id`.
  UI-side code imports it to drive authorisation flows; runtime-side code
  imports it to load the correct adapter.

A change to either contract is a major-version event.

## Memory-graph write + correction policies

Two allowlists gate mutations on the temporal context graph:

- `memory-graph-write-policy` — decides who may append a new node.
- `memory-graph-correction-policy` — decides who may emit a `supersedes`
  or `contradicts` edge.

By default both are closed: only the agent runtime under the Loop's
authority may write, and only the consolidation job may correct. Hosts
can loosen these policies at boot.
