# @melandlabs/opencontext

## 0.6.0

### Minor Changes

- Expose the LLM reasoning layer (query-rewriter + iterative planner) over the HTTP and MCP daemons via a new `--reasoning` flag on **`opencontext-memory-http` / `opencontext-memory-mcp`** (the `@melandlabs/memory-store` bins) **and the `opencontext` facade CLI** (`opencontext http --reasoning`, `opencontext mcp --reasoning`). The bin reads `OPENCONTEXT_LLM_API_KEY` / `OPENCONTEXT_LLM_BASE_URL` / `OPENCONTEXT_LLM_MODEL` from the environment — your existing `.env` works as-is — and wires `unified.reasoning.{queryRewriter, iterativePlanner}` via a raw OpenAI-compatible chat completions fetch (no new SDK dep). Reasoning stays **off by default**; if `OPENCONTEXT_LLM_API_KEY` is missing the bin refuses to start with a clear remediation message rather than silently degrading.

  `POST /v1/search` body and `memory.search` MCP tool now accept a `reasoningStrategy` field (`"none" | "rewrite" | "iterative"`). The response carries a `reasoning` block (`{ strategy, iterations, evidenceCount, degraded }`) so callers can observe what ran. Verified end-to-end against the DeepSeek model in `.env` — iterative: `iterations > 0`, no `*_not_configured` warnings; rewrite: no warnings.

### Patch Changes

- Updated dependencies [bbf2485]
  - @melandlabs/okf@0.2.1

## 0.5.1

### Patch Changes

- Fix the asymmetry between `opencontext add --kind` and `opencontext search --kind`: the write path was persisting the kind under `metadata.kind` (a dead key — no code path reads it), while the search filter was reading the `fact_type` column, which the write path never populated. `search --kind experience` therefore always returned zero hits for any message the CLI had written.

  `add --kind <value>` now writes to the top-level `factType` on the `RawMessage` (the same field `memory-store` persists to `fact_type`), making the two flags symmetric. The legacy `metadata.kind` write was removed. Help text updated to document the closed set `world | experience | mental_model` that `search --kind` recognises, while still accepting any free-form string for forward compatibility (validated at search time, not at write time).

## 0.5.0

### Minor Changes

- b86d8d0: This changeset ships OKF (Open Knowledge Format) v0.2 as a first-class
  import / export format for the opencontext memory store. The OKF spec
  itself is unchanged — what changes is the surface that bridges it to
  `RawMessage`.

  **What's new**

  - **`@melandlabs/okf`** — new package. Codec (`okfToRawMessage` /
    `rawMessageToOkf`), package I/O (`readOkfPackage` /
    `writeOkfPackage`), CLI (`startOkf({action: ingest | emit | validate |
inspect})`), HTTP (`registerOkfRoutes`), MCP (`registerOkfTools`).
    Round-trip semantics: the front-matter `resource` is honoured as the
    canonical `messageId`, so `emit → ingest` upserts in place rather
    than creating `-2` suffixed duplicates.
  - **`@melandlabs/contracts`** — adds `OkfFrontMatter`, `OkfDocument`,
    `OkfPackageManifest` schemas, the canonical `OKF_TYPES` set
    (`Reference`, `Concept`, `Experience`, `Episode`, `Opinion`,
    `MentalModel`, `Belief`), and `okfTypeToFactType` /
    `factTypeToOkfType` inverses. Front-matter is `.passthrough()` so
    vendor-specific extension flags survive the round-trip under
    `metadata.okfExtras` without being lifted into first-class fields.
  - **`@melandlabs/memory-store`** — the unified daemon now exposes
    `POST /v1/okf/import`, `POST /v1/okf/import-batch`,
    `POST /v1/okf/export`, `memory.okfImport`, `memory.okfExport`,
    re-using the same `OkfRunOptions.sink` so HTTP / MCP / CLI agree on
    the `issues[]` envelope.
  - **`@melandlabs/opencontext`** — `opencontext okf ingest | emit |
validate | inspect` subcommand, plus facade re-exports of the OKF
    surface so host apps don't reach into the subpackage.

  **Required front-matter**

  Blocking (`exit=1` regardless of `--continue-on-error`):

  - `type` present (`missing_type`)
  - `generated.at` present and parseable (`missing_generated_at`)
  - valid YAML inside a front-matter fence (`invalid_yaml` /
    `invalid_frontmatter`)
  - non-empty body (`empty_body`)

  Soft warnings (surfaced in `issues[]`, do not force non-zero exit):

  - `generated.by` absent (`missing_generated_by`)
  - `description`, `tags`, `sources`, `verified`, `stale_after`,
    `supersedes` / `superseded_by` absent

  `validate` agrees with `ingest`: a file is `valid: true` only when
  no blocking issue is present.

  **Backward compatibility**

  - New public surface is purely additive. Existing `RawMessage` /
    `FactType` consumers are unaffected.
  - `yaml@^2` is added to the runtime tree (transitive dep of
    `@melandlabs/okf`); `tsup` already keeps it external so the
    opencontext bundle doesn't grow.
  - The SQLite scope-conflict guard still fires when a re-ingest tries
    to land the same `messageId` under a different `userId` — that
    hasn't changed.

- a435e2e: Add LanceDB and Milvus hybrid vector stores, reusable RRF and weighted fusion,
  and expose hybrid retrieval through the OpenContext facade.

### Patch Changes

- Updated dependencies [6fc52c9]
- Updated dependencies [b86d8d0]
  - @melandlabs/ai-rag@0.2.9
  - @melandlabs/okf@0.2.0

## 0.4.1

### Minor Changes

- `store.search()` is now the single read entry point. The previous
  `searchUnifiedMemory` / `searchRawMemorySemantically` / `reflect` methods
  remain available as `@deprecated` aliases forwarding to `search()`. The
  `reflect` LLM synthesis is now opt-in via
  `search({ synthesize: true | { responseSchema } })`.

  `reflectWithPlan()` is unchanged — its write-side surface (graph +
  storage) is intentionally separate from read.

  **Migration**

  - `store.searchUnifiedMemory(input)` → `store.search(input)`
  - `store.reflect(input)` → `store.search({ ...input, synthesize: true })`
  - `store.searchRawMemorySemantically(input)` →
    `store.search({ ...input, sources: ["memory"] }).results`

  **MCP / HTTP**

  - `memory.searchUnified` + `memory.reflect` → single `memory.search`
    tool. **No deprecation aliases** on the wire surface.
  - `POST /v1/search` + `POST /v1/reflect` → single `POST /v1/search`
    (set `synthesize: true` for LLM synthesis). **No deprecation alias.**

  **SDK public methods**

  - `store.searchUnifiedMemory` / `store.searchRawMemorySemantically` /
    `store.reflect` remain as `@deprecated` thin wrappers forwarding to
    `store.search`. Removal planned for the next minor.

### Patch Changes

- @melandlabs/ai-rag@0.2.5

## 0.4.0

### Minor Changes

- Add a server-only `app-paths` module to `@melandlabs/env-config` that centralizes the `~/.opencontext` user-directory path logic: `getOpenContextDir()`, `getOpenContextPath(...segments)`, `ensureOpenContextDir(...segments)`, plus the `OPENCONTEXT_HOME` override (with `~/` expansion). Migrate every hardcoded `.opencontext` path computation across the monorepo (loop, audit, memory-store, ai, mcp, integrations, and the `dsh-opencontext` plugin) to use the new helpers, and re-export the unified path API from the `@melandlabs/opencontext` facade.

## 0.3.0

### Minor Changes

- 351c6b2: Add an LLM-backed query rewriter and iterative recall planner to memory-store unified search, and a reasoning-backed memory layer exported from the opencontext facade. Also make LocalStorageProvider storage root injectable with hardened key sanitization, fix API error-body parsing, re-export createClaudeAgent/createCodexAgent factories from @melandlabs/ai/agent, and add vitest suites plus runnable tutorial examples across the monorepo.

### Patch Changes

- Updated dependencies
  - @melandlabs/integrations@0.3.0
  - @melandlabs/security@0.3.0
  - @melandlabs/ai-rag@0.2.4

## 0.2.6

### Patch Changes

- Release @melandlabs/opencontext 0.2.6 and publish updated workspace dependencies.
  - @melandlabs/ai-rag@0.2.3

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
