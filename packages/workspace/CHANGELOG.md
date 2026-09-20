# @melandlabs/workspace

## 0.6.0

### Minor Changes

- 85f0aa4: Extend the multi-format text extractor in `@melandlabs/workspace` to cover `.html` / `.htm` / `.csv` / `.keynote` in addition to the existing `.md` / `.txt` / `.pdf` / `.docx` / `.xlsx` / `.xls` / `.pages` / `.numbers`. Barrel-export `extractText`, `extractTextRaw`, `detectMimeType`, `stripHtmlTags`, and the `ExtractedText` type so external callers (e.g. chokidar folder watchers) can route any of these through the same `extractText` pipeline the OKF bulk indexer already uses. `@melandlabs/okf`'s `indexOkfFolder` picks up the four new extensions automatically; no schema change.

## 0.5.0

### Minor Changes

- Extend the multi-format text extractor and barrel-export it so external callers (e.g. chokidar-based folder watchers) can route `.md` / `.txt` / `.html` / `.htm` / `.csv` / `.pdf` / `.docx` / `.xlsx` / `.xls` / `.pages` / `.numbers` / `.keynote` through the same `extractText` pipeline the OKF bulk indexer already uses.

  - `parsers-adapter.ts`
    - **New**: `.html` / `.htm` pass-through with a best-effort `stripHtmlTags` (removes `<script>` / `<style>` / `<!-- -->` / `<!doctype>` / `<?xml?>`, decodes `&nbsp;` / `&` / `<` / `>` / `"` / `&#39;`). `@melandlabs/rag`'s parser has no HTML loader, so the strip lives here.
    - **New**: `.csv` routed through `parseFileToDocument` → `CSVLoader` (already wired in `@melandlabs/rag`).
    - **New**: `.keynote` reaches `parseFileToDocument` → `AppleDocumentLoader` (already wired; previously dropped at the `SUPPORTED_EXTENSIONS` gate).
    - **Added** `.csv` to `MIME_BY_EXTENSION` (was previously `application/octet-stream`).
    - Header docstring updated to enumerate all 12 supported extensions.
  - `okf-backend.ts`
    - `SUPPORTED_EXTENSIONS` gains `.html`, `.htm`, `.csv`, `.keynote`.
    - `resourceTypeForExtension` returns `"note"` for `.csv`, `"html"` for `.html` / `.htm`, `"document"` for `.keynote`.
  - `index.ts`
    - Exports `extractText`, `extractTextRaw`, `detectMimeType`, `stripHtmlTags`, and the `ExtractedText` type from the package barrel. These were previously internal — only `indexOkfFolder` / `listOkfFolderResources` were public.
  - `test/parsers-adapter.test.ts`
    - Covers MIME detection for `.html` / `.htm` / `.csv`.
    - Covers `stripHtmlTags` (script / style / comment / DOCTYPE / entity removal).
    - Covers `extractText` for `.html` end-to-end.

  No schema change. No behaviour change for the bulk `indexOkfFolder` path beyond picking up four new extensions.

## 0.4.0

### Minor Changes

- 52814fb: Add the v0.3 wiki-distillation surface to `@melandlabs/workspace`:

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

### Patch Changes

- Fix three connected memory-search bugs and ship Node 22/24/26 install support.

  - **`@melandlabs/memory-store`** — honour `asOf` (time-travel) and dedup warnings across the lexical + ANN recall paths.
    - Historical (`asOf`) queries now return the historical revision, not the latest. `searchRawMessagesLexical` / `searchRawMessagesAnn` forward `asOf` to the SQLite lexical/semantic backends; the SQLite queries themselves apply a `created_at <= @asOf` window (normalising the seconds/milliseconds unit drift between `created_at` and `deprecated_at`).
    - `includeDeprecated: true` now respects `asOf` — audits see the rows that existed at the snapshot instead of every revision ever stored.
    - "No embedding provider configured" no longer fires twice per response (consolidated to a single `memory_lexical_search_fallback` warning).
  - **`@melandlabs/sqlite`** — expose `asOf` on `SQLiteRawMessageSemanticSearchInput` / `SQLiteRawMessageLexicalSearchInput` and apply it across `searchChunksWithStoredEmbeddings`, `searchLegacyMessagesLexically`, `searchMessagesWithStoredEmbeddings`, and `matchesSemanticFilters`. Raise vitest timeout to 60 s so cold ONNX model downloads on fresh runners don't race the 5 s default.
  - **Workspace-wide** — bump `better-sqlite3` from `^11.10.0` / `^11.7.0` to `^13.0.0` (N-API prebuilds cover Node 22, 24, and 26 — no more Visual Studio Build Tools required on Windows), widen `engines.node` to `>=22.0.0 <27.0.0`, add a `pnpm.overrides` pin so `@langchain/community` stops installing a nested better-sqlite3@11 copy that fails to compile against Node 26 V8 headers, drop the legacy `sqlite3` entry from `pnpm.onlyBuiltDependencies`, and add a `native-sqlite` CI matrix on Node 22/24/26.

- Updated dependencies
- Updated dependencies [52814fb]
  - @melandlabs/sqlite@0.5.4
  - @melandlabs/rag@0.3.3
  - @melandlabs/contracts@0.8.0
  - @melandlabs/okf@0.3.4
  - @melandlabs/ai-rag@0.2.12

## 0.3.1

### Patch Changes

- The 0.3.0 tarball listed the internal `@melandlabs/*` runtime deps as
  `workspace:*`, which npm does not resolve when the package is installed
  on its own. As a result `pnpm dlx @melandlabs/workspace` installed the
  CLI without its `okf`/`rag`/`shared`/`sqlite`/`contracts`/`env-config`
  deps, and the CLI silently no-op'd on every invocation.

  Pin those deps to concrete npm ranges (`^0.7.0` / `^0.4.0` / `^0.3.3` /
  `^0.3.2` / `^0.4.2` / `^0.5.3`) so the published tarball pulls them in.
  The local `pnpm.overrides` for `@melandlabs/workspace` still forces the
  workspace symlink for in-repo development.

## 0.3.0

### Minor Changes

- ee3bda2: Add `@melandlabs/workspace` — a CLI for indexing an OKF / Markdown folder into SQLite and querying it with lexical, semantic, hybrid, and cross-file strategies. Reuses the existing `~/.opencontext/memory/store.db` schema and exposes `opencontext workspace update|search|list` subcommands.

  The workspace CLI defaults `EMBEDDING_PROVIDER=local` (`Xenova/all-MiniLM-L6-v2`, 384 dims) so demos and OKF review workflows run offline without `OPENROUTER_API_KEY`. Multi-format parsing covers `.md`, `.markdown`, `.txt`, `.pdf`, `.docx`, and `.pages`. Cross-file strategy walks `cites` edges extracted from Markdown links for BFS-style expansion across related files.

- 378a3aa: Add Excel / Apple Numbers spreadsheet parsing to `@melandlabs/workspace`'s `parsers-adapter`. `.xlsx` and `.xls` are converted via SheetJS (`xlsx`) — one CSV block per sheet, prefixed with `# Sheet: <name>` so the chunker preserves sheet boundaries. `.numbers` files are first converted with macOS `textutil -convert xlsx`, then routed through the SheetJS path.

  The OKF walker now picks up `.xlsx`, `.xls`, and `.numbers` (macOS) alongside the existing `.md`, `.markdown`, `.txt`, `.pdf`, `.docx`, and `.pages` formats, and tags them with `resource_type: "spreadsheet"`.

  The 22-workspace demo now ships a 6-file fixture folder (`.md` × 3, `.pdf`, `.docx`, `.xlsx`) and asserts `filesScanned ≥ 6`, `filesAdded ≥ 6`, `listWorkspaceResources ≥ 6`, and that the re-run reports every file as `unchanged` under sha256 dedup.

### Patch Changes

- bb7fae2: Fix two bugs in `@melandlabs/workspace`:

  1. **Cross-file edges now pick up markdown links inside non-`.md` files.** `indexOkfFolder` previously only ran `buildGraphFromDir` over raw `.md` files, so `cites` edges inside `.pdf` / `.docx` / `.xlsx` bodies were silently lost. The indexer now scans extracted text bodies for `[label](./relative/path.md)` links and writes `cites` edges for matches, so the cross-file strategy can traverse from a parsed document back into a Markdown statute or contract clause.

  2. **`--db-path` is now honored by every workspace subcommand.** `update`, `search`, and `list` previously ignored the `--db-path` flag and always opened the default `~/.opencontext/memory/store.db`. The flag is now threaded through to `getSQLiteWorkspaceStore({ dbPath })`, so smoke tests and per-project scratch DBs actually isolate.

## 0.1.0

### Minor Changes

- Initial public release.
- CLI: `opencontext workspace update|search|list` (via the `@melandlabs/opencontext` facade) plus `workspace` bin for direct invocation after this release.
- Storage: reuses the `~/.opencontext/memory/store.db` SQLite schema from `@melandlabs/memory-store`.
- New tables: `workspace_resources`, `workspace_resource_versions`, `workspace_chunks` + `workspace_chunks_fts`, `workspace_reference_edges`, `workspace_jobs`, and per-dim vec0 child tables (`workspace_chunks_vec_d{384,1536}`).
- Search strategies: lexical (FTS5 MATCH), semantic (sqlite-vec KNN with widen-and-retry), hybrid (RRF k=60), cross-file (hybrid + cites-edge BFS up to 2 hops).
- Multi-format parsers: `.md` / `.markdown` / `.txt` pass-through, `.pdf` / `.docx` / `.pages` via `@melandlabs/rag` parsers, `.xlsx` / `.xls` / `.numbers` via SheetJS (`.numbers` first converted with macOS `textutil -convert xlsx`).
- Cross-file edges: extracted from raw Markdown links via `buildGraphFromDir` AND from markdown links found inside parsed bodies of non-`.md` files.
- Local embeddings by default: `EMBEDDING_PROVIDER=local` (`Xenova/all-MiniLM-L6-v2`, 384 dims) so demos run offline without `OPENROUTER_API_KEY`.

### Patch Changes

- `--db-path` is honored by every subcommand (`update`, `search`, `list`); previously the flag was parsed but never threaded through to `getSQLiteWorkspaceStore`, so the CLI silently used `~/.opencontext/memory/store.db` regardless of the override.
