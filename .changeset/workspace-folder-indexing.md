---
"@melandlabs/workspace": minor
"@melandlabs/opencontext": minor
---

Add `@melandlabs/workspace` — a CLI for indexing an OKF / Markdown folder into SQLite and querying it with lexical, semantic, hybrid, and cross-file strategies. Reuses the existing `~/.opencontext/memory/store.db` schema and exposes `opencontext workspace update|search|list` subcommands.

The workspace CLI defaults `EMBEDDING_PROVIDER=local` (`Xenova/all-MiniLM-L6-v2`, 384 dims) so demos and OKF review workflows run offline without `OPENROUTER_API_KEY`. Multi-format parsing covers `.md`, `.markdown`, `.txt`, `.pdf`, `.docx`, and `.pages`. Cross-file strategy walks `cites` edges extracted from Markdown links for BFS-style expansion across related files.
