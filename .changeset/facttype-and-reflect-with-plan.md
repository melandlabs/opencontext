---
"@melandlabs/ai": minor
"@melandlabs/memory-consolidation": minor
"@melandlabs/indexeddb": minor
"@melandlabs/sqlite": minor
"@melandlabs/memory-store": minor
---

Two additive capabilities land together:

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
