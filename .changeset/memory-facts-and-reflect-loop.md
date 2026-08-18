---
"@melandlabs/contracts": minor
"@melandlabs/ai": minor
"@melandlabs/ai-memory-consolidation": minor
"@melandlabs/indexeddb": minor
"@melandlabs/sqlite": minor
"@melandlabs/memory-store": minor
"@melandlabs/vsa": minor
---

This changeset replaces the per-feature changesets that were consolidated when the prior release commit (`3549f3d5`) bumped `memory-store` to `1.0.0` and consumed the original entries (`facttype-and-reflect-with-plan`, `peer-reflection-reranker`, `vsa-verb`). The source changes they documented remain in the diff vs `main`, so a changeset is required to keep the PR's `Changesets` CI check green.

**Scope** — the underlying features themselves are unchanged; only the changeset metadata was lost. The three original entries covered:

- **Memory fact typing** — `FactType` union (`world` / `experience` / `mental_model`) on `AtomicFactChunk` / `MemoryRecord`, with the additive `factTypes` filter on `MemorySearchQuery` / `MemorySemanticRecallQuery`. IndexedDB `DB_VERSION` 3 → 4 and SQLite `RAW_MESSAGES_SCHEMA_VERSION` 3 → 4 are non-destructive and idempotent against v3 rows.
- **`reflect()` + `reflectWithPlan()`** — single-turn LLM synthesis (`reflect`) and agentic write-back loop (`reflectWithPlan`) over summary / raw / insight / knowledge tiers. New `@melandlabs/ai-memory-consolidation/reflect-planner` module and `memory-store-graph` wiring point. LLM failures degrade gracefully (evidence preserved, typed warnings emitted).
- **Peer model + RRF default + Reranker adapter** — `Peer` type and `peerFilter` / `peerScopeCheck` inputs. `searchUnifiedMemory` defaults to RRF; opt back into similarity via `deps.reasoning.defaultMergeStrategy = "similarity"`. Optional `Reranker` slot with `IdentityReranker` passthrough.
- **`@melandlabs/vsa`** — new package for Holographic Reduced Representation (`bind` / `unbind` / `superpose` / `cleanup` / `randomHRRVector` + in-memory `FactStore`); zero runtime deps. Already published as `@melandlabs/vsa@0.2.0` before this branch.

**Backward compatibility**

- `FactType`, `peer`, `peerIds`, `decidedByPeer` are additive everywhere; existing fields (`userId`, `botId`, `participantIds`, `decidedBy`) are preserved.
- `reflect()` (read-only) is unchanged. `reflectWithPlan`, `MemoryStore.graphStore`, and `MemoryStoreConfig.graphStore?` are new and optional.
- All new `UnifiedSearchDeps` slots are optional; existing call sites continue to work unchanged.
- `applyReflectedConsolidationPlan` is idempotent (`persistPlan` dedupes on `operationId`, `deprecateRecords` no-ops on already-deprecated rows).
- `searchUnifiedMemory` callers that don't pass `mergeStrategy` will see result ordering change — set `deps.reasoning.defaultMergeStrategy = "similarity"` for the legacy similarity order.

**Version note**

The packages above were already bumped in `3549f3d5` (e.g. `memory-store` 0.4.0 → 1.0.0, `contracts` 0.4.0 → 0.5.0, `sqlite` 0.4.0 → 0.5.0, `vsa` 0.2.0 → 0.3.0). The next `pnpm version` run will apply another minor bump on top — that is expected and matches the project's changeset convention.