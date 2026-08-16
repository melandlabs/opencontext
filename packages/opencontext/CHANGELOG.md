# @melandlabs/opencontext

## 0.2.5

### Patch Changes

- Persist local embedding cache to a stable user-level directory so model weights survive `npx` installs, expose `getCacheDir()` on `LocalTransformersEmbeddingProvider`, and add `--embedding-cache-dir` / `LOCAL_EMBEDDING_CACHE_DIR` support to the OpenContext CLI. Also suppress the `loop-cli` warning in `opencontext doctor` when running from the published npm bundle.
- Updated dependencies
  - @melandlabs/ai-rag@0.2.2

## 0.2.3

### Patch Changes

- Fixed: HTTP server now updates sqlite-vec vector table when embedOnInsert is used
- Fixed: HTTP server now supports lexical search as fallback for keyword queries
- Semantic search in HTTP server now works with local embeddings

## 0.2.2

### Patch Changes

- Fixed: Added SQLite semantic search fallback for messages with pre-computed embeddings
- SDK mode semantic search now works with stored embeddings without requiring Chroma

## 0.2.1

### Patch Changes

- Fixed: `@melandlabs/ai-rag` is now a regular dependency instead of an optional peer dependency

  Previously, `@melandlabs/ai-rag` was marked as an optional peer dependency, but the code had static
  re-exports from it, causing runtime errors when the package wasn't installed. Now it's a regular
  dependency that gets installed automatically with `@melandlabs/opencontext`.

## 0.1.5

### Patch Changes

- 0.1.5 — externalize `cross-spawn` from the facade bundle

  `@melandlabs/opencontext` re-exports `@melandlabs/ai`'s agent public API
  through the root barrel, and the agent providers (codex, opencode,
  openclaw, hermes, claude, …) all import `cross-spawn`. tsup was bundling
  the entire `cross-spawn` source tree into the ESM-only facade dist,
  which wraps every internal `require('child_process')` call inside tsup's
  `__commonJS` shim. Loading the facade under Node 22 ESM (the examples
  runner with `--experimental-strip-types`, `opencontext mcp` over stdio,
  …) then threw:

      Error: Dynamic require of "child_process" is not supported

  Externalize `cross-spawn` in `packages/opencontext/tsup.config.ts` so
  Node's resolver loads the real CJS package and `require` works normally,
  and add `cross-spawn` to the facade's `dependencies` so consumers get
  it at install time.

## 0.1.4

### Patch Changes

- 1b57367: 0.1.4 — expose @melandlabs/ai agent public API + restore MODEL_PRICING re-exports

  `@melandlabs/ai` now surfaces the full IAgent contract surface at the
  package root: `BaseAgent`, `IAgent`, `AgentRegistry`, `AgentRuntime`,
  `defineAgentPlugin`, `registerAgentPlugin`, `getAgentInstance`,
  `getAgentRegistry`, `getRegisteredAgentProviders`,
  `runAgentRuntimeRequest`, plus the `StandaloneAgent` built-in
  provider (`StandaloneAgent`, `standaloneAgentPlugin`,
  `STANDALONE_METADATA`). Previously consumers had to import from the
  awkward `@melandlabs/ai/agent` subpath, which made it impossible to
  exercise the IAgent contract from the package's headline entry
  point.

  `StandaloneAgent` is a `BaseAgent` subclass that does exactly one LLM
  call per `run` / `plan` / `execute` via `createDynamicModel` +
  `generateText`, yielding the standard `AgentMessage` stream
  (`session` → `text` → `result`, or `error`). No tools, no plan store,
  no sandbox. Registered via `registerAgentPlugin(standaloneAgentPlugin)`
  with the matching `STANDALONE_METADATA` descriptor; `"standalone"`
  is now part of the `BuiltinAgentProvider` union.

  The `agent/index.ts` barrel was trimmed to drop re-exports that
  collide with sibling submodules (`./billing`, `./compaction`,
  `./context`, `./model`, `./routing`) or with the package's own
  `./types` (`ProviderMetadata`, `ProviderCapabilities`,
  `extractJsonFromMarkdown`); those names keep reaching the root via
  direct submodule imports so no consumer path breaks.

  Also restore `IMAGE_MODEL_PRICING` and `AUDIO_MODEL_PRICING` re-exports
  on the `@melandlabs/ai` billing block (the previous release silently
  removed them when it trimmed the agent barrel; the auto-generated
  `packages/opencontext/src/ai-reexport.ts` was still importing both,
  which broke the Release workflow's `pnpm -r --filter './packages/**'
build` DTS pass against downstream packages).

  New runnable demo: `examples/src/demo/17-ai-agent.ts` exercises the
  new surface — 27 static assertions over the IAgent / BaseAgent /
  registry / runtime / plugin contract, plus a live `agent.run(...)`
  call that runs whenever `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
  `OPENROUTER_API_KEY` is set and skips gracefully otherwise.

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

- 1b57367: 0.1.4 — expose @melandlabs/ai agent public API + restore MODEL_PRICING re-exports

  `@melandlabs/ai` now surfaces the full IAgent contract surface at the
  package root: `BaseAgent`, `IAgent`, `AgentRegistry`, `AgentRuntime`,
  `defineAgentPlugin`, `registerAgentPlugin`, `getAgentInstance`,
  `getAgentRegistry`, `getRegisteredAgentProviders`,
  `runAgentRuntimeRequest`, plus the `StandaloneAgent` built-in
  provider (`StandaloneAgent`, `standaloneAgentPlugin`,
  `STANDALONE_METADATA`). Previously consumers had to import from the
  awkward `@melandlabs/ai/agent` subpath, which made it impossible to
  exercise the IAgent contract from the package's headline entry
  point.

  `StandaloneAgent` is a `BaseAgent` subclass that does exactly one LLM
  call per `run` / `plan` / `execute` via `createDynamicModel` +
  `generateText`, yielding the standard `AgentMessage` stream
  (`session` → `text` → `result`, or `error`). No tools, no plan store,
  no sandbox. Registered via `registerAgentPlugin(standaloneAgentPlugin)`
  with the matching `STANDALONE_METADATA` descriptor; `"standalone"`
  is now part of the `BuiltinAgentProvider` union.

  The `agent/index.ts` barrel was trimmed to drop re-exports that
  collide with sibling submodules (`./billing`, `./compaction`,
  `./context`, `./model`, `./routing`) or with the package's own
  `./types` (`ProviderMetadata`, `ProviderCapabilities`,
  `extractJsonFromMarkdown`); those names keep reaching the root via
  direct submodule imports so no consumer path breaks.

  Also restore `IMAGE_MODEL_PRICING` and `AUDIO_MODEL_PRICING` re-exports
  on the `@melandlabs/ai` billing block (the previous release silently
  removed them when it trimmed the agent barrel; the auto-generated
  `packages/opencontext/src/ai-reexport.ts` was still importing both,
  which broke the Release workflow's `pnpm -r --filter './packages/**'
build` DTS pass against downstream packages).

  New runnable demo: `examples/src/demo/17-ai-agent.ts` exercises the
  new surface — 27 static assertions over the IAgent / BaseAgent /
  registry / runtime / plugin contract, plus a live `agent.run(...)`
  call that runs whenever `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
  `OPENROUTER_API_KEY` is set and skips gracefully otherwise.

- Updated dependencies [1de8e1a]
  - @melandlabs/ai-rag@0.1.4

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
