# @melandlabs/workspace

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
