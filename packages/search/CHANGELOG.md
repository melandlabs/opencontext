# @melandlabs/search

## 0.3.0

### Minor Changes

- Bump the remaining @melandlabs/\* packages to 0.3.0 alongside the test-suite / memory-search minor release. Aligns every published package on the 0.3 line so the facade `@melandlabs/opencontext@0.3.0` and its transitive workspace dependencies share a single coherent version.

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

## 0.1.1

### Patch Changes

- Repair broken `exports` paths that blocked ESM resolution:

  - `@melandlabs/config`: ship CJS at the published entry point (tsup only
    emits `.cjs` because `src/eslint.js` uses `module.exports` while the
    package is `"type": "module"`).
  - `@melandlabs/i18n`: `./locales/{en-US,zh-Hans}` now point to the
    flat `dist/locales-{en-US,zh-Hans}.js` files that tsup emits.
  - `@melandlabs/indexeddb`: drop the stale `./storage` export (the file
    was never built).
  - `@melandlabs/integrations-gmail`: add missing `"."` export so the
    package's main entry resolves under Node 22 ESM.
  - `@melandlabs/integrations-telegram`: `./tdata-decrypter` now points
    to `dist/tdata-decrypter-index.js`.
  - `@melandlabs/integrations-weixin`: `./cdn/*` now points to the flat
    `dist/cdn-*.js` files.
  - `@melandlabs/opencontext`: add missing `"."` export.
  - `@melandlabs/search`: `./brave` now points to `dist/brave-index.js`.
  - `@melandlabs/storage`: `./adapters`, `./adapters/local-fs`,
    `./adapters/vercel-blob` now point to the flat
    `dist/adapters-*.js` files.
