---
"@melandlabs/memory-store": patch
"@melandlabs/opencontext": patch
---

Hardening pass for memory-store + opencontext daemons after the published-package
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
