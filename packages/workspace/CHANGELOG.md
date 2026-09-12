# @melandlabs/workspace

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
