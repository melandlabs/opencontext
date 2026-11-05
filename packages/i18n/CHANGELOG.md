# @melandlabs/i18n

## 0.3.5

### Patch Changes

- fix(agent): stop repeating the native-runner document context twice

  Every prompt context the native runner builds carried its content twice — a
  "System Note: The user has ..." block followed by a near-identical "System
  Note: User has ..." block, each with its own instruction paragraph, and the
  focused-insight block repeated the same `Note:` / `Tip:` sentence verbatim.
  Four blocks were affected: the RAG document hint, the focused-insight hint,
  the saved file attachments hint, and the saved RAG documents hint.

  The model reads the same instruction list twice on every turn that carries
  documents or insights, and the two copies disagree on wording, so the second
  one is pure token cost with no extra meaning. Each block is now emitted once,
  keeping the more precise phrasing of the pair.

  The dead `common.toolNames` labels for tools that are no longer registered —
  `getFullDocumentContent`, `listKnowledgeBaseDocuments`, `searchUnifiedMemory`,
  `getRawMessages` and `searchRawMessages` — are dropped as well, so the only
  context retrieval label left is `common.toolNames.searchContext`.

## 0.3.4

### Patch Changes

- fix(agent): name the live retrieval tool in the native-runner document hints

  The native-runner prompt contexts told the model to call `searchKnowledgeBase`
  with a `documentIds` parameter — six times, across the RAG-document hint and
  the focused-insight hint. No `searchKnowledgeBase` tool is registered any
  more: the knowledge base, raw chat history and structured conversation
  insights were fused into one `searchContext` retrieval tool, and the legacy
  knowledge-document tools were dropped along with it.

  A prompt that names an unregistered tool makes the model emit "No such tool
  available", which is a hard mid-task error rather than a degraded answer.

  All six references now name `searchContext`, which is the single context
  retrieval tool the host registers. The `documentIds` parameter it points at is
  the knowledge-document selection on that tool, so "search ONLY within these
  specific documents" stays executable.

  The dead `common.toolNames.searchKnowledgeBase` i18n label is dropped so the
  only context tool label is `common.toolNames.searchContext`.

## 0.3.3

### Patch Changes

- fix(agent): name live search tools in the workspace instruction

  The "Search Rules" block told the model to call `searchKnowledgeBase`,
  `searchRawMessages` and `chatInsight` in parallel. None of those three tools
  exist any more — the knowledge base, raw chat history and structured
  conversation insights were fused into one `searchContext` retrieval tool. A
  prompt that names an unregistered tool makes the model emit
  "No such tool available", which is a hard mid-task error rather than a
  degraded answer.

  The block now names `searchContext` (knowledge base docs/files/uploads, chat
  history, structured conversation insights) and `searchMemoryPath`, both of
  which are registered. The `searchMemoryPath` co-call invariant is unchanged
  apart from following the rename.

  The `common.toolNames.chatInsight` i18n key is renamed to
  `common.toolNames.searchContext` to match.

## 0.3.2

### Patch Changes

- Version bump only — no code changes in this package since its last release. Cut to keep the published set in lockstep with the packages that did change in this release.

Skips 0.3.1, which was already present on npm: that version was published without a corresponding commit to this repo, so the working tree was still at 0.3.0 and the automated bump collided with the existing release.

## 0.3.1

### Patch Changes

- Version bump only — no code changes in these packages since their last release. Cut to keep the published set in lockstep with the packages that did change in this release.

## 0.3.0

### Minor Changes

- Bump the remaining @melandlabs/\* packages to 0.3.0 alongside the test-suite / memory-search minor release. Aligns every published package on the 0.3 line so the facade `@melandlabs/opencontext@0.3.0` and its transitive workspace dependencies share a single coherent version.

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
