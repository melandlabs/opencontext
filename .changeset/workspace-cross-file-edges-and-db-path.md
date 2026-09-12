---
"@melandlabs/workspace": patch
---

Fix two bugs in `@melandlabs/workspace`:

1. **Cross-file edges now pick up markdown links inside non-`.md` files.** `indexOkfFolder` previously only ran `buildGraphFromDir` over raw `.md` files, so `cites` edges inside `.pdf` / `.docx` / `.xlsx` bodies were silently lost. The indexer now scans extracted text bodies for `[label](./relative/path.md)` links and writes `cites` edges for matches, so the cross-file strategy can traverse from a parsed document back into a Markdown statute or contract clause.

2. **`--db-path` is now honored by every workspace subcommand.** `update`, `search`, and `list` previously ignored the `--db-path` flag and always opened the default `~/.opencontext/memory/store.db`. The flag is now threaded through to `getSQLiteWorkspaceStore({ dbPath })`, so smoke tests and per-project scratch DBs actually isolate.
