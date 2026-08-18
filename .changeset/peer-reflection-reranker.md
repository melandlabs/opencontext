---
"@melandlabs/contracts": minor
"@melandlabs/memory-store": minor
"@melandlabs/vsa": minor
---

Three additive capabilities land together, each isolated to its owning package:

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
