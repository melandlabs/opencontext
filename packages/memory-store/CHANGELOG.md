# @melandlabs/memory-store

## 1.1.4

### Patch Changes

- 4351a4a: Load `@melandlabs/okf/http` and `@melandlabs/okf/mcp` lazily inside the HTTP / MCP server start functions instead of via static `import`. This breaks the workspace DTS cycle between memory-store and OKF (memory-store → okf via `dependencies`, okf → memory-store via `devDependencies`) so `pnpm -r build` can serialize memory-store before OKF and emit `dist/http.d.ts` / `dist/mcp.d.ts` without needing OKF's types on disk first. Runtime behavior is unchanged — `@melandlabs/okf` remains a regular `dependency` so the dynamic `import()` resolves at startup in any host that already has the OKF package installed.

  Also unblocks the release workflow's `publish` job, which has been red since the v0.2 OKF release because the same DTS cycle crashed memory-store's `tsup --dts` step before it could produce the tarballs that the `smoke` job installs from npmjs.org.

  - @melandlabs/okf@0.2.0

## 1.1.3

### Patch Changes

- 6fa5b89: Republish to replace the workspace:\* deps that slipped into 1.1.2.

  `memory-store@1.1.2` was uploaded with raw `workspace:*` specifiers (e.g.
  `@melandlabs/ai: workspace:*`) after a manual version bump to dodge
  npm's 24-hour republish cooldown. Downstream installs that resolve
  against the public registry — most importantly the release `smoke`
  job, which runs `pnpm install --ignore-workspace` against npmjs.org —
  fail with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` because no workspace
  exists outside the monorepo.

  Bumping to 1.1.3 routes through `pnpm changeset publish`, which calls
  `pnpm pack` to generate the tarball. `pnpm pack` substitutes the
  linked workspace versions into the packaged `package.json`, so the
  published artifact carries versioned deps (`@melandlabs/ai: 0.7.0`,
  `@melandlabs/okf: 0.2.0`, …) — verified locally against the same
  `packages/memory-store` tree that the release workflow builds.

  No source change vs 1.1.1 / 1.1.2; the `factType?: FactType` type
  addition to `RawMessage` and the OKF HTTP / MCP wiring are already
  shipped. 1.1.2 is deprecated on npm with a pointer to 1.1.3.

- Updated dependencies [f550140]
  - @melandlabs/ai@0.7.1
  - @melandlabs/okf@0.2.0

## 1.1.2

### Patch Changes

- Add the optional `factType?: FactType` field to the public `RawMessage` interface in `@melandlabs/memory-store/contracts`. The SQLite storage adapter already persisted `fact_type` to its column and the retrieval-side `RawMessageQuery.factTypes` filter already read it, but the public type omitted the field, forcing callers that set it (e.g. the `opencontext add --kind` CLI) to cast through `as any`. The IndexedDB `RawMessage` already had `factType?`, so this aligns the two boundary types.

  No runtime change — purely a type-only addition. Storage and search behavior are unchanged.

  - @melandlabs/okf@0.2.0

## 1.1.0

### Minor Changes

- b86d8d0: This changeset ships OKF (Open Knowledge Format) v0.2 as a first-class
  import / export format for the opencontext memory store. The OKF spec
  itself is unchanged — what changes is the surface that bridges it to
  `RawMessage`.

  **What's new**

  - **`@melandlabs/okf`** — new package. Codec (`okfToRawMessage` /
    `rawMessageToOkf`), package I/O (`readOkfPackage` /
    `writeOkfPackage`), CLI (`startOkf({action: ingest | emit | validate |
inspect})`), HTTP (`registerOkfRoutes`), MCP (`registerOkfTools`).
    Round-trip semantics: the front-matter `resource` is honoured as the
    canonical `messageId`, so `emit → ingest` upserts in place rather
    than creating `-2` suffixed duplicates.
  - **`@melandlabs/contracts`** — adds `OkfFrontMatter`, `OkfDocument`,
    `OkfPackageManifest` schemas, the canonical `OKF_TYPES` set
    (`Reference`, `Concept`, `Experience`, `Episode`, `Opinion`,
    `MentalModel`, `Belief`), and `okfTypeToFactType` /
    `factTypeToOkfType` inverses. Front-matter is `.passthrough()` so
    vendor-specific extension flags survive the round-trip under
    `metadata.okfExtras` without being lifted into first-class fields.
  - **`@melandlabs/memory-store`** — the unified daemon now exposes
    `POST /v1/okf/import`, `POST /v1/okf/import-batch`,
    `POST /v1/okf/export`, `memory.okfImport`, `memory.okfExport`,
    re-using the same `OkfRunOptions.sink` so HTTP / MCP / CLI agree on
    the `issues[]` envelope.
  - **`@melandlabs/opencontext`** — `opencontext okf ingest | emit |
validate | inspect` subcommand, plus facade re-exports of the OKF
    surface so host apps don't reach into the subpackage.

  **Required front-matter**

  Blocking (`exit=1` regardless of `--continue-on-error`):

  - `type` present (`missing_type`)
  - `generated.at` present and parseable (`missing_generated_at`)
  - valid YAML inside a front-matter fence (`invalid_yaml` /
    `invalid_frontmatter`)
  - non-empty body (`empty_body`)

  Soft warnings (surfaced in `issues[]`, do not force non-zero exit):

  - `generated.by` absent (`missing_generated_by`)
  - `description`, `tags`, `sources`, `verified`, `stale_after`,
    `supersedes` / `superseded_by` absent

  `validate` agrees with `ingest`: a file is `valid: true` only when
  no blocking issue is present.

  **Backward compatibility**

  - New public surface is purely additive. Existing `RawMessage` /
    `FactType` consumers are unaffected.
  - `yaml@^2` is added to the runtime tree (transitive dep of
    `@melandlabs/okf`); `tsup` already keeps it external so the
    opencontext bundle doesn't grow.
  - The SQLite scope-conflict guard still fires when a re-ingest tries
    to land the same `messageId` under a different `userId` — that
    hasn't changed.

### Patch Changes

- Updated dependencies [6fc52c9]
- Updated dependencies [6fc52c9]
- Updated dependencies [b86d8d0]
- Updated dependencies [448387a]
- Updated dependencies [a435e2e]
  - @melandlabs/ai@0.7.0
  - @melandlabs/ai-rag@0.2.9
  - @melandlabs/contracts@0.6.0
  - @melandlabs/okf@0.2.0
  - @melandlabs/shared@0.4.0
  - @melandlabs/rag@0.3.0
  - @melandlabs/indexeddb@0.5.8
  - @melandlabs/sqlite@0.5.1

## 1.0.0

### Minor Changes

- f31460c: Two additive capabilities land together:

  - **`FactType` field** — atomic facts are now classified as `world`, `experience`, or `mental_model`. The `FactType` union lives in `@melandlabs/ai/memory/contracts`; it surfaces on `AtomicFactChunk.factType`, `MemoryRecord.factType`, and as the `factTypes` filter on `MemorySearchQuery` / `MemorySemanticRecallQuery`. The two `rawMessageToMemoryRecord` adapters (indexeddb + memory-store) carry the field through. IndexedDB bumps `DB_VERSION` 3 → 4 (additive `factType` index on `raw_messages`) and SQLite bumps `RAW_MESSAGES_SCHEMA_VERSION` 3 → 4 (additive `fact_type` column + partial index). Both migrations are idempotent and tolerate v3 rows whose `factType` is undefined.
  - **`store.reflectWithPlan()`** — agentic write-back loop. Gathers evidence via the same pipeline as `reflect()`, builds a rule-based consolidation plan (`MemoryConsolidationPlan`), optionally vets it through the configured LLM (`reasoning.complete`), and persists via `MemoryGraphStore.persistPlan` + `MemoryStorageAdapter.deprecateRecords`. Landing in three new modules:
    - `@melandlabs/ai-memory-consolidation/reflect-planner` — `buildReflectedConsolidationPlan` + `applyReflectedConsolidationPlan`. LLM vet only approves or vetoes existing entries — it never invents new operations. Failure modes emit typed warnings (`reflect_apply_llm_skipped`, `reflect_apply_llm_vet_failed`, `reflect_apply_graph_store_not_configured`, `reflect_apply_dry_run`, `reflect_apply_no_writes`) and fall back to the deterministic plan.
    - `@melandlabs/memory-store/search/apply-reflect` — `applyReflectedPlan(input)` exposes the write-back loop with the same `peerFilter` / `tiers` / `limit` / `threshold` surface as `reflect()`.
    - `@melandlabs/memory-store/memory-store-graph` — `attachMemoryGraphStore(store, { storage, ownerScope })` is the opt-in wiring point. Without it, `reflectWithPlan` still runs `deprecateRecords` against the storage adapter and emits a warning.
    - HTTP `POST /v1/reflect:apply` and MCP `memory.reflectWithPlan` expose the same surface.

  **Backward compatibility**

  - `FactType` is optional everywhere; v3 → v4 migration is non-destructive and v3 rows survive with `factType: undefined`.
  - `reflect()` (read-only) is unchanged. `MemoryStore.graphStore` and `MemoryStore.reflectWithPlan` are new optional fields.
  - `MemoryStoreConfig.graphStore?` is new and optional; not wiring it leaves `reflectWithPlan` in deprecate-only mode.
  - All new `UnifiedSearchDeps` slots are optional; existing call sites continue to work unchanged.
  - `applyReflectedConsolidationPlan` is idempotent — `persistPlan` deduplicates on `operationId` and `deprecateRecords` no-ops on already-deprecated rows.

- aaf039a: Three additive capabilities land together, each isolated to its owning package:

  - `@melandlabs/contracts` — new `Peer` type (`{ kind: "user" | "agent", id: string }`) plus `peerKey` / `parsePeerKey` / `asPeer` / `asPeers` / `isPeer` / `isPeerKind` helpers. `Episode` gains an optional `peerIds` field, `Decision` gains an optional `decidedByPeer`, and `RawMessage` (memory-store schema) gains an optional `peer`. Existing `participantIds` / `decidedBy` / `userId`+`botId` fields are preserved.
  - `@melandlabs/memory-store`
    - New `reflect()` operation: single-turn LLM synthesis over already-gathered evidence across summary, raw, insight, and knowledge tiers. Exposed via `POST /v1/reflect` (HTTP) and `memory.reflect` (MCP). LLM failures degrade gracefully (no throw, evidence preserved, warning added).
    - RRF (`Reciprocal Rank Fusion`) is now the default merge strategy for `searchUnifiedMemory`. Callers can fall back via `deps.reasoning.defaultMergeStrategy = "similarity"`. `mergeStrategy: "similarity"` and `"rrf"` continue to work as explicit overrides.
    - Optional `Reranker` adapter (with an `IdentityReranker` passthrough) for re-ordering the merged result list before applying the final limit.
    - New `searchSummaries` provider wired through `RawMessageManager.querySummaries` (sqlite).
    - New `peerFilter` input on `UnifiedMemorySearchInput`, plus `peerScopeCheck` for host-side narrowing.
  - `@melandlabs/vsa` — new package providing Holographic Reduced Representation primitives: `bind` / `unbind` / `superpose` / `cleanup` / `randomHRRVector` plus an in-memory `FactStore`. Zero runtime dependencies. The `bind`/`unbind` pair is the inverse-correlation form (`Σ_j a[j]·b[(i+j) mod D]` / `Σ_j c[j]·a[(i-j) mod D]`), so cleanup works against the original vocabulary without per-role shift correction. See `packages/vsa/README.md` for capacity guidance (≈ √D distinct records).

  **Backward compatibility**

  - `userId` remains required. `botId` / `botIds` storage and `participantIds` / `decidedBy` fields are preserved on their owning types.
  - `RawMessage.peer` is added only in the memory-store schema; the indexeddb schema is unchanged (documented asymmetry).
  - `searchUnifiedMemory` callers that do not pass `mergeStrategy` will see result ordering change. Set `deps.reasoning.defaultMergeStrategy = "similarity"` for the legacy similarity order.
  - All new dependencies in `UnifiedSearchDeps` are optional; existing call sites continue to work unchanged.

- e9cb443: `@melandlabs/memory-store` ships a new `store.vsa` facade — Vector Symbolic Architecture recall as a sibling verb to `store.search`.

  - **Why**: Semantic search returns top-K nearest neighbours by cosine similarity. VSA returns a single best-match from a closed vocabulary. The two surfaces are intentionally separate — folding both into one result shape would require a confusing union type and a fake `similarity` field that doesn't mean the same thing across sources.

  - **Surface**: four verbs on `MemoryStore.vsa`:

    - `vsaStoreFact({ userId, roleLabel, roleVector, fillerLabel, fillerVector, dim, scopeTag?, botId? })` — persist a (role, filler) binding as a HRR pair. Returns `{ factId, createdAt }`.
    - `vsaRecall({ userId, roleLabel, roleVector, vocabulary, scopeTag?, botId?, maxFacts? })` — re-superpose stored facts, unbind by the requested role, cleanup against the vocabulary, return the best-match label + sorted score list.
    - `vsaListFacts({ userId, scopeTag?, botId?, limit? })` — read-side projection (vectors stripped). Useful for diagnostics and audit.
    - `vsaForget({ userId, factIds, reason? })` — soft-delete by id. Idempotent.

  - **Storage**: backed by a new `vsa_facts` table in `@melandlabs/sqlite` (Float32 BLOBs for the vectors, idempotent `CREATE TABLE IF NOT EXISTS`). Shares the same SQLite DB as the raw-message manager; no separate migration step.

  - **Persistence contract**: `VsaFactStorage` interface in `@melandlabs/contracts/vsa-fact` (`storeFact` / `queryFacts` / `deprecateFacts`). `SQLiteVsaStore` is the bundled implementation; hosts can register their own backend.

  - **HTTP**: `POST /v1/vsa/store`, `POST /v1/vsa/recall`, `POST /v1/vsa/list`, `POST /v1/vsa/forget` on the daemon.

  - **MCP**: `memory.vsaStore`, `memory.vsaRecall`, `memory.vsaList`, `memory.vsaForget` on the stdio server.

  - **Workspace dependency**: `@melandlabs/memory-store` gains `workspace:*` on `@melandlabs/vsa`.

  - **Capacity**: HRR superpositions tolerate noise gracefully but degrade as you approach √D stored facts (Plate, 1995). For `D = 128` that's roughly 11 facts before crosstalk dominates a single best-match cleanup. For dense recall (thousands of facts) use `D = 512` or `D = 1024`. The facade accepts whatever dimension you store; mismatches between facts with different `dim` values are surfaced as `vsa_dim_mismatch` warnings and dropped before superposition.

### Patch Changes

- Updated dependencies [f31460c]
- Updated dependencies [aaf039a]
- Updated dependencies [e9cb443]
  - @melandlabs/ai@0.5.0
  - @melandlabs/memory-consolidation@0.5.0
  - @melandlabs/indexeddb@0.5.0
  - @melandlabs/sqlite@0.5.0
  - @melandlabs/contracts@0.5.0
  - @melandlabs/vsa@0.3.0
  - @melandlabs/ai-rag@0.2.6

## 0.4.0

### Minor Changes

- f31460c: Two additive capabilities land together:

  - **`FactType` field** — atomic facts are now classified as `world`, `experience`, or `mental_model`. The `FactType` union lives in `@melandlabs/ai/memory/contracts`; it surfaces on `AtomicFactChunk.factType`, `MemoryRecord.factType`, and as the `factTypes` filter on `MemorySearchQuery` / `MemorySemanticRecallQuery`. The two `rawMessageToMemoryRecord` adapters (indexeddb + memory-store) carry the field through. IndexedDB bumps `DB_VERSION` 3 → 4 (additive `factType` index on `raw_messages`) and SQLite bumps `RAW_MESSAGES_SCHEMA_VERSION` 3 → 4 (additive `fact_type` column + partial index). Both migrations are idempotent and tolerate v3 rows whose `factType` is undefined.
  - **`store.reflectWithPlan()`** — agentic write-back loop. Gathers evidence via the same pipeline as `reflect()`, builds a rule-based consolidation plan (`MemoryConsolidationPlan`), optionally vets it through the configured LLM (`reasoning.complete`), and persists via `MemoryGraphStore.persistPlan` + `MemoryStorageAdapter.deprecateRecords`. Landing in three new modules:
    - `@melandlabs/ai-memory-consolidation/reflect-planner` — `buildReflectedConsolidationPlan` + `applyReflectedConsolidationPlan`. LLM vet only approves or vetoes existing entries — it never invents new operations. Failure modes emit typed warnings (`reflect_apply_llm_skipped`, `reflect_apply_llm_vet_failed`, `reflect_apply_graph_store_not_configured`, `reflect_apply_dry_run`, `reflect_apply_no_writes`) and fall back to the deterministic plan.
    - `@melandlabs/memory-store/search/apply-reflect` — `applyReflectedPlan(input)` exposes the write-back loop with the same `peerFilter` / `tiers` / `limit` / `threshold` surface as `reflect()`.
    - `@melandlabs/memory-store/memory-store-graph` — `attachMemoryGraphStore(store, { storage, ownerScope })` is the opt-in wiring point. Without it, `reflectWithPlan` still runs `deprecateRecords` against the storage adapter and emits a warning.
    - HTTP `POST /v1/reflect:apply` and MCP `memory.reflectWithPlan` expose the same surface.

  **Backward compatibility**

  - `FactType` is optional everywhere; v3 → v4 migration is non-destructive and v3 rows survive with `factType: undefined`.
  - `reflect()` (read-only) is unchanged. `MemoryStore.graphStore` and `MemoryStore.reflectWithPlan` are new optional fields.
  - `MemoryStoreConfig.graphStore?` is new and optional; not wiring it leaves `reflectWithPlan` in deprecate-only mode.
  - All new `UnifiedSearchDeps` slots are optional; existing call sites continue to work unchanged.
  - `applyReflectedConsolidationPlan` is idempotent — `persistPlan` deduplicates on `operationId` and `deprecateRecords` no-ops on already-deprecated rows.

- aaf039a: Three additive capabilities land together, each isolated to its owning package:

  - `@melandlabs/contracts` — new `Peer` type (`{ kind: "user" | "agent", id: string }`) plus `peerKey` / `parsePeerKey` / `asPeer` / `asPeers` / `isPeer` / `isPeerKind` helpers. `Episode` gains an optional `peerIds` field, `Decision` gains an optional `decidedByPeer`, and `RawMessage` (memory-store schema) gains an optional `peer`. Existing `participantIds` / `decidedBy` / `userId`+`botId` fields are preserved.
  - `@melandlabs/memory-store`
    - New `reflect()` operation: single-turn LLM synthesis over already-gathered evidence across summary, raw, insight, and knowledge tiers. Exposed via `POST /v1/reflect` (HTTP) and `memory.reflect` (MCP). LLM failures degrade gracefully (no throw, evidence preserved, warning added).
    - RRF (`Reciprocal Rank Fusion`) is now the default merge strategy for `searchUnifiedMemory`. Callers can fall back via `deps.reasoning.defaultMergeStrategy = "similarity"`. `mergeStrategy: "similarity"` and `"rrf"` continue to work as explicit overrides.
    - Optional `Reranker` adapter (with an `IdentityReranker` passthrough) for re-ordering the merged result list before applying the final limit.
    - New `searchSummaries` provider wired through `RawMessageManager.querySummaries` (sqlite).
    - New `peerFilter` input on `UnifiedMemorySearchInput`, plus `peerScopeCheck` for host-side narrowing.
  - `@melandlabs/vsa` — new package providing Holographic Reduced Representation primitives: `bind` / `unbind` / `superpose` / `cleanup` / `randomHRRVector` plus an in-memory `FactStore`. Zero runtime dependencies. The `bind`/`unbind` pair is the inverse-correlation form (`Σ_j a[j]·b[(i+j) mod D]` / `Σ_j c[j]·a[(i-j) mod D]`), so cleanup works against the original vocabulary without per-role shift correction. See `packages/vsa/README.md` for capacity guidance (≈ √D distinct records).

  **Backward compatibility**

  - `userId` remains required. `botId` / `botIds` storage and `participantIds` / `decidedBy` fields are preserved on their owning types.
  - `RawMessage.peer` is added only in the memory-store schema; the indexeddb schema is unchanged (documented asymmetry).
  - `searchUnifiedMemory` callers that do not pass `mergeStrategy` will see result ordering change. Set `deps.reasoning.defaultMergeStrategy = "similarity"` for the legacy similarity order.
  - All new dependencies in `UnifiedSearchDeps` are optional; existing call sites continue to work unchanged.

- `store.search()` is now the single read entry point. The previous
  `searchUnifiedMemory` / `searchRawMemorySemantically` / `reflect` methods
  remain available as `@deprecated` aliases forwarding to `search()`. The
  `reflect` LLM synthesis is now opt-in via
  `search({ synthesize: true | { responseSchema } })`.

  `reflectWithPlan()` is unchanged — its write-side surface (graph +
  storage) is intentionally separate from read.

  **Migration**

  - `store.searchUnifiedMemory(input)` → `store.search(input)`
  - `store.reflect(input)` → `store.search({ ...input, synthesize: true })`
  - `store.searchRawMemorySemantically(input)` →
    `store.search({ ...input, sources: ["memory"] }).results`

  **MCP / HTTP**

  - `memory.searchUnified` + `memory.reflect` → single `memory.search`
    tool. **No deprecation aliases** on the wire surface.
  - `POST /v1/search` + `POST /v1/reflect` → single `POST /v1/search`
    (set `synthesize: true` for LLM synthesis). **No deprecation alias.**

  **SDK public methods**

  - `store.searchUnifiedMemory` / `store.searchRawMemorySemantically` /
    `store.reflect` remain as `@deprecated` thin wrappers forwarding to
    `store.search`. Removal planned for the next minor.

### Patch Changes

- Updated dependencies [f31460c]
- Updated dependencies [aaf039a]
  - @melandlabs/ai@0.4.0
  - @melandlabs/memory-consolidation@0.4.0
  - @melandlabs/indexeddb@0.4.0
  - @melandlabs/sqlite@0.4.0
  - @melandlabs/contracts@0.4.0
  - @melandlabs/vsa@0.2.0
  - @melandlabs/ai-rag@0.2.5

## 0.3.1

### Patch Changes

- Updated dependencies
  - @melandlabs/env-config@0.4.0
  - @melandlabs/ai@0.3.1

## 0.3.0

### Minor Changes

- 351c6b2: Add an LLM-backed query rewriter and iterative recall planner to memory-store unified search, and a reasoning-backed memory layer exported from the opencontext facade. Also make LocalStorageProvider storage root injectable with hardened key sanitization, fix API error-body parsing, re-export createClaudeAgent/createCodexAgent factories from @melandlabs/ai/agent, and add vitest suites plus runnable tutorial examples across the monorepo.

### Patch Changes

- Updated dependencies
- Updated dependencies [351c6b2]
  - @melandlabs/indexeddb@0.3.0
  - @melandlabs/sqlite@0.3.0
  - @melandlabs/ai@0.3.0
  - @melandlabs/shared@0.3.0
  - @melandlabs/ai-rag@0.2.4
  - @melandlabs/rag@0.2.2

## 0.2.7

### Patch Changes

- Release @melandlabs/opencontext 0.2.6 and publish updated workspace dependencies.
- Updated dependencies
  - @melandlabs/ai@0.2.1
  - @melandlabs/indexeddb@0.2.1
  - @melandlabs/rag@0.2.1
  - @melandlabs/shared@0.2.1
  - @melandlabs/sqlite@0.2.1
  - @melandlabs/ai-rag@0.2.3

## 0.2.6

### Patch Changes

- Updated dependencies
  - @melandlabs/ai-rag@0.2.2

## 0.1.6

### Patch Changes

- Updated dependencies
  - @melandlabs/rag@0.1.5

## 0.1.5

### Patch Changes

- Updated dependencies [1b57367]
  - @melandlabs/ai@0.2.0

## 0.1.4

### Patch Changes

- 1de8e1a: 0.1.3 — unified daemon flags for HTTP and MCP, plus runnable examples

  Both `opencontext http` and `opencontext mcp` now accept the same
  `--embedding-provider` / `--*-backend` flag surface as `@melandlabs/ai-rag`
  ships, so the four `unified.*` deps (`embedQuery`, `searchRawMessagesAnn`,
  `searchInsights`, `searchKnowledge`) can be wired from a single CLI. The
  default `opencontext mcp` bin is now backed by a real JSON-RPC handshake
  (initialize → notifications/initialized → tools/list → tools/call) with
  four memory tools: `memory.health`, `memory.searchUnified`,
  `memory.writeRawMessage`, `memory.getRawMessage`. The `mcp` server also
  honors `MEMORY_MCP_NAME` and `MEMORY_MCP_VERSION` env vars and a
  `--name` / `--version` flag pair.

  Added two runnable examples to `examples/` that exercise the new daemon
  surface end-to-end against the real sqlite-vec + LocalTransformers
  embedder:

  - `examples/src/demo/15-http-server.ts` — spawns the HTTP daemon, hits
    `/health`, writes a raw message, runs a `searchUnified` query, and
    asserts the only warnings are the expected
    `*_not_configured` for the unused sources.
  - `examples/src/demo/16-mcp-server.ts` — spawns the MCP daemon over
    stdio, drives the full JSON-RPC handshake, writes two raw messages
    with `embedOnInsert: true`, and asserts the unified search returns
    at least one memory hit with no spurious warnings.

  Top-level README and `examples/README.md` (English + Chinese) now
  describe the daemon configuration, the `embedOnInsert` HTTP write
  option, and how to wire the MCP server into Claude Desktop / Cursor.

  Also: switched a stdout-polluting `console.log` in
  `packages/sqlite/src/raw-message-manager.ts` to `console.error` so the
  MCP stdio transport stays a clean JSON-RPC stream.

- Updated dependencies [1de8e1a]
- Updated dependencies [1b57367]
  - @melandlabs/ai@0.2.0
  - @melandlabs/ai-rag@0.1.4
  - @melandlabs/indexeddb@0.1.4
  - @melandlabs/rag@0.1.4
  - @melandlabs/shared@0.1.4
  - @melandlabs/sqlite@0.1.4

## 0.1.1

### Patch Changes

- Updated dependencies
  - @melandlabs/indexeddb@0.1.1
  - @melandlabs/ai@0.1.0
  - @melandlabs/rag@0.1.0
  - @melandlabs/shared@0.1.0
  - @melandlabs/sqlite@0.1.1
