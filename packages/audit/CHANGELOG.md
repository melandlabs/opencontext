# @melandlabs/audit

## 0.3.5

### Patch Changes

- bbad897: Import `node:fs` and `node:child_process` as default rather than namespace imports in `installAuditInterceptors`.

  `import * as fs from "node:fs"` binds an ES module namespace object, whose properties are getter-only accessors. Every monkey-patched assignment therefore threw `TypeError: Cannot set property readFileSync of [object Module] which has only a getter`, and the whole install — `fs` _and_ `child_process` — aborted on the first line. The failure was invisible in CJS bundles, where the same import lowers to `require("fs")` and lands on a mutable exports object, so it only surfaced once a consumer bundled the package as real ESM (Next.js server chunks on Vercel logged it on every cold start). A non-zero `installed` flag meant the audit trail was silently dead for the life of the process.

  The default import is the live CommonJS exports object — mutable and shared process-wide, so it is the only form that intercepts anything at all. Callers that had worked around the symptom by gating the call on their own environment can drop that workaround once they upgrade.

## 0.3.4

### Patch Changes

- Version bump only — no code changes in these packages since their last release. Cut to keep the published set in lockstep with the packages that did change in this release.
- Updated dependencies
  - @melandlabs/env-config@0.4.1

## 0.3.3

### Patch Changes

- 6b1d418: Replace CommonJS `require()` with static ESM imports inside the interceptor and
  logger. The package is published as ESM (`format: ["esm"]`, `"type": "module"`),
  so the previous `require()` calls inside `installAuditInterceptors()` were
  rejected by Next.js / Turbopack bundlers with `dynamic usage of require is not
supported`, leaving the audit interceptors silently un-installed on the server.
  Adds a `tsconfig.json` extending the shared bundler-resolution config so the
  `@melandlabs/env-config/app-paths` subpath import resolves cleanly. Native
  `fs` / `child_process` monkey-patching is now done through `any`-typed aliases
  so esbuild accepts the property assignment.

## 0.3.1

### Patch Changes

- Updated dependencies
  - @melandlabs/env-config@0.4.0

## 0.3.0

### Minor Changes

- 351c6b2: Add an LLM-backed query rewriter and iterative recall planner to memory-store unified search, and a reasoning-backed memory layer exported from the opencontext facade. Also make LocalStorageProvider storage root injectable with hardened key sanitization, fix API error-body parsing, re-export createClaudeAgent/createCodexAgent factories from @melandlabs/ai/agent, and add vitest suites plus runnable tutorial examples across the monorepo.

## 0.2.1

### Patch Changes

- Release @melandlabs/opencontext 0.2.6 and publish updated workspace dependencies.

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
