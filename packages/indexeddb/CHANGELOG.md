# @melandlabs/indexeddb

## 0.5.8

### Patch Changes

- Updated dependencies [b86d8d0]
  - @melandlabs/contracts@0.6.0

## 0.5.7

### Patch Changes

- Add the optional `platforms?: string[]` field to `RawMessageQuery`. Acts as an additional connector allowlist on top of the singular `platform`. Consumers that want the SQL clause `platform IN (?, ?, …)` build it from this list directly.

## 0.5.6

### Patch Changes

- Add the `./client` subpath export so apps can import `@melandlabs/indexeddb/client` directly (same surface as `@melandlabs/indexeddb`, but loaded as its own tsup entry so dynamic `import()` calls get a smaller bundle).

## 0.5.5

### Patch Changes

- Add the `RawMessageSearchHooks` interface (`searchMessagesSemantically`, `lexicalSearch` as optional methods) and have `RawMessageStorageManager` extend it. Also export the `RawMessageSemanticHit` / `RawMessageLexicalHit` shapes. Apps that gate on `typeof storage.searchMessagesSemantically === "function"` (unified-search route) compile against the published types. No runtime change for backends that don't implement these hooks.

## 0.5.4

### Patch Changes

- Add the `./extractor` and `./grouping` subpath exports so apps can import platform extractor helpers (`RawMessageData`, `extractSlackMessages`, …) and the `groupRawMessagesByPeriod` utility directly. `grouping.ts` is the same implementation that used to live in `packages/indexeddb/src/grouping.ts` before the opencontext rename.

## 0.5.3

### Patch Changes

- Declare the optional `forgettingCycle` method on `RawMessageStorageManager` so apps that gate on `typeof storage.forgettingCycle === "function"` (the IndexedDB→SQLite migration runner) compile against the published types. Add the `RawMessageForgettingCycleResult` shape that the optional method returns. No runtime behavior change for backends that don't implement it.

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

### Patch Changes

- Updated dependencies [aaf039a]
- Updated dependencies [e9cb443]
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

- Updated dependencies [aaf039a]
  - @melandlabs/contracts@0.4.0

## 0.3.0

### Minor Changes

- Bump the remaining @melandlabs/\* packages to 0.3.0 alongside the test-suite / memory-search minor release. Aligns every published package on the 0.3 line so the facade `@melandlabs/opencontext@0.3.0` and its transitive workspace dependencies share a single coherent version.

## 0.2.1

### Patch Changes

- Release @melandlabs/opencontext 0.2.6 and publish updated workspace dependencies.

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

## 0.1.1

### Patch Changes

- Repair broken `exports` paths that blocked ESM resolution:

  - `@melandlabs/config`: ship CJS at the published entry point (tsup only
    emits `.cjs` because `src/eslint.js` uses `module.exports` while the
    package is `"type": "module"`).
  - `@melandlabs/i18n`: `./locales/{en-US,zh-Hans}` now point to the
    flat `dist/locales-{en-US,zh-Hans}.js` files that tsup emits.
  - `@melandlabs/indexeddb`: drop the stale `./storage` export (the file
    was never built).
  - `@melandlabs/integrations-gmail`: add missing `"."` export so the
    package's main entry resolves under Node 22 ESM.
  - `@melandlabs/integrations-telegram`: `./tdata-decrypter` now points
    to `dist/tdata-decrypter-index.js`.
  - `@melandlabs/integrations-weixin`: `./cdn/*` now points to the flat
    `dist/cdn-*.js` files.
  - `@melandlabs/opencontext`: add missing `"."` export.
  - `@melandlabs/search`: `./brave` now points to `dist/brave-index.js`.
  - `@melandlabs/storage`: `./adapters`, `./adapters/local-fs`,
    `./adapters/vercel-blob` now point to the flat
    `dist/adapters-*.js` files.
