# @melandlabs/sqlite

## 0.5.1

### Patch Changes

- Updated dependencies [b86d8d0]
  - @melandlabs/contracts@0.6.0
  - @melandlabs/indexeddb@0.5.8

## 0.5.0

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
  - @melandlabs/indexeddb@0.5.0
  - @melandlabs/contracts@0.5.0

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

### Patch Changes

- Updated dependencies [f31460c]
- Updated dependencies [aaf039a]
  - @melandlabs/indexeddb@0.4.0
  - @melandlabs/contracts@0.4.0

## 0.3.0

### Minor Changes

- Bump the remaining @melandlabs/\* packages to 0.3.0 alongside the test-suite / memory-search minor release. Aligns every published package on the 0.3 line so the facade `@melandlabs/opencontext@0.3.0` and its transitive workspace dependencies share a single coherent version.

### Patch Changes

- Updated dependencies
  - @melandlabs/indexeddb@0.3.0

## 0.2.1

### Patch Changes

- Release @melandlabs/opencontext 0.2.6 and publish updated workspace dependencies.
- Updated dependencies
  - @melandlabs/indexeddb@0.2.1

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
  - @melandlabs/indexeddb@0.1.4

## 0.1.1

### Patch Changes

- Updated dependencies
  - @melandlabs/indexeddb@0.1.1
