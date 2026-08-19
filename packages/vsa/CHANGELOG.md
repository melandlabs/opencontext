# @melandlabs/vsa

## 0.3.0

### Minor Changes

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

## 0.2.0

### Minor Changes

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
