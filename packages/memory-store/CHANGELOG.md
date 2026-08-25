# @melandlabs/memory-store

## 1.2.1

### Patch Changes

- Updated dependencies
  - @melandlabs/contracts@0.7.0

  Follow-up to 1.2.0: `contracts@0.7.0` adds the `./derived-fact` and
  `./entity-edge` subpath exports whose compiled imports ship inside
  `memory-store`'s dist. Pinning `contracts@0.7.0` here so the
  previously-published `1.2.0`'s subpath imports resolve at install
  time — without this the published-package smoke test exits with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## 1.2.0

### Minor Changes

- Opt-in first-class retrieval primitives + per-channel scoring on the
  unified search pipeline. All three new primitives follow the existing
  degraded-mode contract: when a host dep isn't wired in, the SDK
  surfaces a structured warning and returns an empty result instead of
  throwing. Surface area is strictly additive — no existing API changed
  its signature and the new `signals` field on `UnifiedMemorySearchResult`
  is optional, so this is a `minor` rather than a `major` bump.

  **Distill (per-message entity extraction).** New
  `distillRawMessage(unified, input)` primitive in
  `@melandlabs/memory-store/search/distill`. Host injects an LLM /
  rule-based extractor via `UnifiedSearchDeps.entityExtractor`. Returns
  `{ edges, warnings }`; emits `distill_extractor_not_configured`,
  `distill_extractor_failed`, and
  `distill_extractor_returned_invalid_shape` under the respective failure
  modes. Normalization silently drops entries with unknown `EntityKind`
  values (closed enum: person / place / org / product / event / concept /
  other) and fills in `extractedAt`. New
  `@melandlabs/contracts/entity-edge` subpath export carries the shared
  `EntityEdge` / `EntityKind` contract.

  **Derive (windowed fact synthesis).** New
  `deriveFacts(unified, input)` primitive in
  `@melandlabs/memory-store/search/derive`. Host injects a deriver via
  `UnifiedSearchDeps.deriver`. When `candidateTexts` is omitted the
  primitive pulls candidates via the lexical sub-query; if no topical
  `query` is supplied it falls back to `userId + botIds` and emits
  `derive_fallback_query_noise` so the Loop-engine scheduler knows to
  pass a query next time. Emits `derive_no_candidates`,
  `derive_deriver_failed`, `derive_deriver_returned_invalid_shape`, and
  `derive_persist_failed` under their respective failure modes. New
  `@melandlabs/contracts/derived-fact` subpath export carries the shared
  `DerivedFact` / `DerivedKind` contract (closed union of summary /
  frequency / contradiction_candidate / temporal_trend).

  **Entity-search channel.** New optional
  `UnifiedSearchDeps.entitySearch` sub-query provider surfaces matches
  as `UnifiedMemorySearchResult`s and fuses them with semantic + lexical
  via RRF. Under the default `similarity` merge strategy standalone
  entity hits are suppressed (entity scores live on a different scale
  than cosine / BM25) and a `memory_entity_requires_rrf` warning is
  emitted so callers can opt into RRF when they actually want entity
  matches.

  **Per-hit signals.** Every `store.search()` hit now carries an
  optional `signals?: HitSignals` field populated by `materializeSignals`:
  `{ channels, semantic?, lexical?, entity?, rrf? }`. `channels` lists
  which retrieval paths contributed; per-channel scores carry the
  highest-ranked appearance; `rrf` mirrors the fused RRF score when RRF
  is active.

  **Transports + diagnostics.**

  - New `memory.distill` / `memory.derive` MCP tools and matching
    `POST /v1/distill` / `POST /v1/derive` HTTP endpoints, both
    surfaced from the same `{ edges | facts, warnings }` shape as the
    in-process primitives.
  - `opencontext doctor` gains three opt-in env-var-gated sections
    (`OPENCONTEXT_ENTITY_EXTRACTOR`, `OPENCONTEXT_ENTITY_SEARCH`,
    `OPENCONTEXT_DERIVER`) so hosts can self-diagnose whether their
    wiring is complete before runtime warnings start firing.

  **Docs + examples.**

  - New "Extract, Derive, and Per-Hit Signals" section in
    `docs/tutorials/03-advanced-usage.md`.
  - New customer-health-scoring use-case doc
    (`docs/tutorials/use-cases/08-customer-health-scoring.md`) and
    runnable example (`examples/src/tutorials/use-cases/35-customer-health-scoring.ts`).
  - New `examples/src/tutorials/42-extract-derive.ts` walks through
    `distillRawMessage` + `deriveFacts` + per-hit `signals` against
    the umbrella facade with stub host deps.

  **Breaking changes worth flagging in release notes (not breaking for
  existing code paths but call out in upgrade guide).**

  - MCP `memory.distill` / `memory.derive` no longer accept a
    `persist` flag — the transport cannot carry host-side persist
    callbacks and the flag only triggered a log line. Hosts needing
    round-trip persistence should call `distillRawMessage` /
    `deriveFacts` directly.
  - HTTP `/v1/distill` / `/v1/derive` return 500 (not 400) on
    unexpected errors. The primitives are best-effort and shouldn't
    throw; any thrown exception is a server-side bug.
  - `EntityEdge.kind` / `DerivedFact.kind` are now runtime-enforced as
    closed enums — unknown values are silently dropped during
    normalization.

### Patch Changes

- @melandlabs/okf@0.2.1

## 1.1.8

### Patch Changes

- 399796b: Hardening pass for memory-store + opencontext daemons after the published-package
  smoke tests:

  - **Auto-embed-on-insert fallback.** When a writer omits `embedOnInsert` (or
    passes `false`) AND the active backend is vector-based (sqlite-vec, chroma, …)
    AND the host wired `embedQuery`, the server now fills in missing embeddings
    and returns an `embed_on_insert_auto_applied` warning instead of silently
    storing rows with no vectors. Without this, `memory.search` returned 0 hits
    with no error — the worst kind of silent failure. Both the MCP
    `memory.writeRawMessage` tool and the HTTP `POST /v1/raw-messages` handler
    share a new `applyEmbedOnInsertPolicy` helper so the two surfaces can never
    drift again. 11 unit tests pin all three policy paths.

  - **sqlite-vec SIGTERM cleanup.** Both daemons (`opencontext-memory-http`,
    `opencontext-memory-mcp`, and the `opencontext` facade) now close the HTTP /
    MCP server first, await `server.close()`, and only then call
    `closeSQLiteVsaStore()`. This breaks the TLS mutex destructor race that
    produced `libc++abi: … mutex lock failed: Invalid argument` noise on every
    SIGTERM/Ctrl-C. The same pattern is documented in `RELEASING.md`.

  - **MCP stdio wire format is documented.** README, tutorial, and the source
    comment at the `StdioServerTransport` instantiation now call out that the
    transport speaks NDJSON (one JSON-RPC object per line), set by
    `@modelcontextprotocol/sdk@1.25.x`. The smoke test exercises both surfaces
    (HTTP + MCP) by talking to the actual published npm tarballs, so any future
    framing change will surface immediately.

  - **CI lockfile consistency check.** A new `lockfile` job runs first in the
    workflow: `pnpm install --lockfile-only` then `git diff --exit-code
pnpm-lock.yaml`. This fails fast on the
    `package.json`-bumped-but-`pnpm-lock.yaml`-not-regenerated mistake that
    broke the 0.6.0 release commit, before any of the expensive
    build/typecheck/lint/test jobs run.

  - **Release runbook.** The `version` script now also runs `pnpm install`
    after `changeset version` (closing the same gap the CI job guards against).
    A new `RELEASING.md` documents the full sequence and the rollback path
    (`npm deprecate` after the 72-hour `npm unpublish` window).
  - @melandlabs/okf@0.2.1

## 1.1.7

### Patch Changes

- Updated dependencies [bbf2485]
- Updated dependencies [35ec14e]
  - @melandlabs/okf@0.2.1
  - @melandlabs/sqlite@0.5.2

## Unreleased

### Patch Changes

- `cli-shared.ts`: add `--reasoning` / `--no-reasoning` /
  `--reasoning-base-url` / `--reasoning-model` / `--reasoning-timeout-ms`
  flags (and `REASONING` / `OPENCONTEXT_LLM_BASE_URL` / `OPENCONTEXT_LLM_MODEL`
  / `OPENCONTEXT_LLM_TIMEOUT_MS` env equivalents). When `--reasoning` is set,
  `buildUnified()` wires `unified.reasoning.{queryRewriter, iterativePlanner}`
  using a raw `fetch` against the OpenAI-compatible chat completions endpoint
  (no `ai` SDK dependency). Honors the `OPENCONTEXT_LLM_API_KEY` env var that
  the `@melandlabs/opencontext` facade already documents — existing `.env`
  files work as-is. Reasoning stays off by default; if `OPENCONTEXT_LLM_API_KEY`
  is missing the bin refuses to start with a clear remediation message.

- `http.ts`: `POST /v1/search` body now plumbs `reasoningStrategy` through
  to `SearchInput.reasoningStrategy` (previously the field was silently
  dropped, so per-call reasoning had no effect over HTTP).

- `mcp.ts`: `memory.search` tool schema gains `reasoningStrategy`
  (`"none" | "rewrite" | "iterative"`, optional), and the handler plumbs
  it through to `SearchInput.reasoningStrategy`. The MCP daemon now mirrors
  the SDK surface for reasoning strategies.

- `cli-http.ts` / `cli-mcp.ts`: `--help` output documents the new reasoning
  flags and includes an end-to-end `--reasoning` example for both daemons.

## 1.1.6

### Patch Changes

- Updated dependencies
  - @melandlabs/ai@0.9.0
  - @melandlabs/okf@0.2.0

## 1.1.5

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @melandlabs/memory-consolidation@0.5.2
  - @melandlabs/ai@0.8.0
  - @melandlabs/okf@0.2.0

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
