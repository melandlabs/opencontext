---
"@melandlabs/contracts": minor
"@melandlabs/workspace": minor
"@melandlabs/opencontext": minor
---

Add the v0.3 wiki-distillation surface to `@melandlabs/workspace`:

- **Citation envelope** (`@melandlabs/contracts/citation`): a unified `Citation` type across `workspace_chunk` / `memory_fact` / `raw_message` layers, with a deterministic `buildCitationId`. Workspace `WorkspaceSearchHit` now carries a first-class `citation` field and `promoted_fact_ids`, populated by every search strategy (lexical / semantic / hybrid / cross-file).
- **`resolveWorkspaceCitation`** — cross-layer citation resolver with `content_hash` drift detection. Workspace chunks are resolved natively; memory facts and raw messages delegate to host-injected resolvers.
- **`distillResource`** — resource-level LLM distillation. Caller supplies the LLM, the candidate target set, and an `autoUpsert` flag (defaults to `false` so proposals return for inspection before being written). Proposals are validated against the candidate set to close the LLM-hallucination loophole.
- **`promoteFactsToPage`** — Memory → Workspace promotion bridge. Materialises a cluster of memory facts as a single OKF page, links the new version back to its source facts via the new `workspace_resource_facts` table, and exposes the linkage on every future search hit.
- **`editChunk`** + **`rollbackToVersion`** — in-place chunk edits with re-embed flag, and version-chain rollback with optional `snapshotCurrent`.
- **`reconcileResourceEdges`** — trim a resource's edge set down to a known-keep list, filterable by edge `provenance`.
- **Edge `provenance`** — every `workspace_reference_edges` row now records its source (`okf_link_resolver`, `okf_frontmatter`, `llm_distill`, `promote_facts`, `manual`, `import`) so later reconciliation can target the right author.
- **EmbeddingQueue** upgraded with concurrency, per-batch timeout, exponential backoff, DLQ (`retryDlq`), and `stats()`.
- **OKF frontmatter `links:`** blocks now round-trip through the graph with `edge_type` (`cites` / `supersedes` / `amends` / `relates-to`) and optional `quote`.
- **Schema bumped** to `WORKSPACE_SCHEMA_VERSION = 2` (idempotent `addColumnIfMissing` + new `workspace_resource_facts` table).
- **New tutorial** `examples/src/tutorials/45-wiki-distillation.ts` exercising every new surface end-to-end.