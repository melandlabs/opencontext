---
"@melandlabs/contracts": minor
"@melandlabs/memory-consolidation": minor
"@melandlabs/sqlite": minor
"@melandlabs/indexeddb": minor
"@melandlabs/memory-store": minor
"@melandlabs/ai": minor
---

Core retrieval + type-system improvements. All additions are backward-compatible — existing callers see the same defaults as before.

## `@melandlabs/contracts`

New boundary types shared between runtime and UI:

- `EntityType` (`person | organization | place | thing | event | concept`) + `EntityTypeSchema` zod enum + `isEntityType()` guard. New `./entity-type` subpath export.
- `Episode` — durable raw-event envelope that a stream of `RawMessage` records belongs to (startedAt, endedAt, participantIds, summary, topicKeys, metadata). New `./episode` subpath export.
- `Decision` — first-class artifact representing an explicit commitment the user/team made (title, rationale, decidedAt, decidedBy, outcome, relatedEpisodeIds, relatedRecordIds). New `./decision` subpath export.

## `@melandlabs/memory-consolidation` (`packages/ai/memory-consolidation`)

- `MemoryGraphRelationKind` extended from 4 to 7 literals: adds `caused`, `influenced`, `precedent-for`. Pure type-level extension; existing literals still resolve.
- `MemoryGraphSnapshotQuery.asOf?: string` — optional ISO-8601 timestamp. When set, the snapshot filter drops nodes/edges/clusters whose `applicability.validFrom`/`validUntil` window is closed at that instant.

## `@melandlabs/indexeddb`

- `filterSnapshot` honors `query.asOf` (via `applicabilityContains`); when `asOf` is absent the function behaves exactly as before. Invalid ISO strings fall back to the legacy behavior.
- `RawMessage.sourceEpisodeId?: string` — optional back-pointer to the originating `Episode`. Preserved by `mergeStoredChatMemoryEvidence`.

## `@melandlabs/sqlite`

- `SQLiteRawMessageManager.lexicalSearchMessages` — BM25 sub-query over the existing `raw_messages_fts` virtual table; exposes `rank` as `bm25Rank` and normalizes to a `[0, 1]` similarity. Returns empty array for empty keywords.
- Schema bumped to v3 with `addColumnIfMissing("raw_messages", "source_episode_id", "TEXT")` (idempotent migration) + a partial index on the new column. `RAW_MESSAGES_SCHEMA_VERSION` updated to 3.
- `RawMessageRow` / `toRawMessage` / `storeMessageSync` round-trip `source_episode_id`.

## `@melandlabs/memory-store`

- `UnifiedSearchDeps.searchRawMessagesLexical?` — optional BM25 sub-query dependency. `runMemorySource` now runs lexical in parallel with the semantic sub-query; emits `memory_lexical_search_failed` on error, `memory_lexical_search_not_configured` when RRF is requested but no lexical provider is configured.
- `UnifiedMemorySearchInput` gains `mergeStrategy?: "similarity" | "rrf"` and `asOf?: string`. `asOf` propagates through `applyGraphAwareRetrieval` into `MemoryGraphSnapshotQuery.asOf`.
- `mergeUnifiedMemorySearchResults` keeps the legacy `(results, limit)` 2-arg form working unchanged; new optional third arg `{ strategy, rankedLists }` selects RRF. Default strategy is still `"similarity"`.
- `mergeUnifiedMemorySearchResultsRrf(lists, limit, k=60)` — reciprocal-rank fusion, dedupes by `(type, id)`, deterministic `(type, id)` lexical tie-break. RRF score lands in `metadata.rrfScore`.
- `normalizeUnifiedMemoryMergeStrategy` — guard that returns `"similarity"` for any unknown / non-string value.
- `RawMessage.sourceEpisodeId?: string` mirrors the new field in `@melandlabs/indexeddb/storage`.

## `@melandlabs/ai`

- `MemoryQueryGraphRetrievalQuery.asOf?: string` — propagated through `applyGraphAwareRetrieval` into the snapshot provider input.
- `MemoryQueryGraphRetrievalSnapshotInput.asOf?: string` — convenience accessor for snapshot providers that read via `MemoryGraphStore.readSnapshot`.
