# @melandlabs/ai

## 0.10.0

### Minor Changes

- Add OpenRouter pricing for `z-ai/glm-5.2` and `z-ai/glm-5.3-flash` so they can be selected through `AgentOptions.model` like the other Zhipu entries.

  - `z-ai/glm-5.2`: input $0.50/M, output $3.15/M, no vision.
  - `z-ai/glm-5.3-flash`: input $0.15/M, output $0.50/M, supports vision. Listed price reflects the 50% launch promo (input $0.075 / output $0.25 per-token basis) that expires 2026-09-09; bump the entry when OpenRouter flips back to list.

## 0.9.1

### Patch Changes

- Add pricing entry for `minimax/minimax-m3` to `MODEL_PRICING` (input $0.30, output $1.20 per million tokens, no vision support).

## 0.9.0

### Minor Changes

- Add `AgentOptions.userContext?: string` and export `appendAgentUserContext(systemPrompt, userContext)` from `@melandlabs/ai/agent`.

  `appendAgentUserContext` is a tiny provider-side helper that wraps pre-rendered user background as an untrusted `<user_context>` block and appends it to a system prompt. Callers own sourcing, formatting, versioning, and freezing the profile snapshot for the run; providers only attach it. The wrapper explicitly labels the content as untrusted descriptive context that must not override system rules, permissions, tool access, privacy limits, or safety policies.

  Ported from alloomi PR #3387 (Feature/user profile pr3 agent injection). The alloomi web app wires `userContext` into `ClaudeAgent` (main / plan / execute prompts) via the `appendAgentUserContext` wrapper.

## 0.8.0

### Minor Changes

- Port Goal Runtime agent symbols from the openloomi fork into `@melandlabs/ai`:

  - Add `GOAL_STEP_COMPLETION_MARKER_OPEN`, `goalStepCompletionMarker`, and
    `stripGoalStepCompletionMarkers` exports in `runtime-instructions/constants.ts`
    so the formatter can emit and strip the per-step completion marker used by
    simplified Goals.
  - Add `"agent_report"` to `GoalCriterionVerificationSchema` so runtime
    instructions can declare agent-report verification, and widen
    `RuntimeProviderSchema` from `"claude"` to `"claude" | "codex"` to match
    the runtime provider surfaces already used in `native-agent/`.
  - Add `replayableInstructionIds: readonly string[]` and the optional
    `replayedInstructions` flag on `AgentRuntimeRecovery` so the host can be
    notified when an outbox replay actually occurred during recovery.
  - Add the tri-state `goalRuntimeSessionId?: string | null` on `AgentOptions`
    and `NativeAgentRunnerContext`, plus the `buildAgentOptions` bridge that
    copies it through (defaulting to `body.sessionId` when undefined and to
    an explicit `null` when the host wants an un-attached chat turn).
  - Teach `formatter.ts` to render the new `agent_report` verification case
    and emit the step-completion protocol block whenever a required
    `agent_report` criterion is present.

  The step-completion marker uses the prefix `OPENCONTEXT_STEP_COMPLETE:`
  (previously `OPENLOOMI_STEP_COMPLETE:` in the openloomi fork). In-flight
  Goals authored against the old prefix will no longer be auto-stripped —
  those targets should be drained or retired before upgrade.

  All changes are additive (new optional fields, a new enum member, a new
  schema case). No existing public API is removed or renamed.

### Patch Changes

- Updated dependencies
  - @melandlabs/memory-consolidation@0.5.2

## 0.7.1

### Patch Changes

- f550140: Fix CodexAgent test plumbing flake on darwin CI. `defaultFakeCodexScript`
  now drains stdin before persisting argv/stdin to disk; on heavily-loaded
  macOS runners the previous "writeFileSync first, attach listeners second"
  ordering could lose the race against an early child exit, surfacing as
  ENOENT on the post-run `readFile`. The `data`/`end` listeners are still
  attached eagerly so `proc.stdin.end()` cannot surface as EPIPE either.

## 0.7.0

### Minor Changes

- 6fc52c9: Surface the additional `agent/*` subpaths required by alloomi (and other downstream consumers):

  - `agent/registry`
  - `agent/cli-process`
  - `agent/prompt-context`
  - `agent/claude/cli-locations`
  - `agent/runtime/output-event-bus`
  - `agent/billing/{index,model-pricing}`
  - `agent/compaction/{index,compaction,compaction-client}`
  - `agent/model/index`
  - `agent/routing/index`
  - `agent/codex/{index,command,interrupt-marker,metadata,parser,runtime-preflight,transport-status}`
  - `agent/hermes/{index,command,metadata}`
  - `agent/openclaw/{index,command,metadata}`
  - `agent/opencode/{index,command,metadata,parser}`
  - `agent/standalone/{index,metadata}`
  - `agent/acp/{agent,mapper,stdio-client}`
  - `agent/native-agent/{native-runner,provider-env,register-provider,runtime-contract,runtime-preference,runtime-probe}`

  `StandAloneAgent.run` now resolves the model through `createDynamicModel(isNativeMode, modelName)` — cloud auth must be configured by calling `setAIUserContext` (with the user JWT) before the agent runs; the standalone agent itself no longer threads `authToken` into the model factory.

### Patch Changes

- Updated dependencies [b86d8d0]
- Updated dependencies [448387a]
  - @melandlabs/contracts@0.6.0
  - @melandlabs/shared@0.4.0

## 0.5.0

### Minor Changes

- f31460c: Two additive capabilities land together:

  - **`FactType` field** — atomic facts are now classified as `world`, `experience`, or `mental_model`. The `FactType` union lives in `@melandlabs/ai/memory/contracts`; it surfaces on `AtomicFactChunk.factType`, `MemoryRecord.factType`, and as the `factTypes` filter on `MemorySearchQuery` / `MemorySemanticRecallQuery`. The two `rawMessageToMemoryRecord` adapters (indexeddb + memory-store) carry the field through. IndexedDB bumps `DB_VERSION` 3 → 4 (additive `factType` index on `raw_messages`) and SQLite bumps `RAW_MESSAGES_SCHEMA_VERSION` 3 → 4 (additive `fact_type` column + partial index). Both migrations are idempotent and tolerate v3 rows whose `factType` is undefined.
  - **`store.reflectWithPlan()`** — agentic write-back loop. Gathers evidence via the same pipeline as `reflect()`, builds a rule-based consolidation plan (`MemoryConsolidationPlan`), optionally vets it through the configured LLM (`reasoning.complete`), and persists via `MemoryGraphStore.persistPlan` + `MemoryStorageAdapter.deprecateRecords`. Landing in three new modules:
    - `@melandlabs/ai-memory-consolidation/reflect-planner` — `buildReflectedConsolidationPlan` + `applyReflectedConsolidationPlan`. LLM vet only approves or vetoes existing entries — it never invents new operations. Failure modes emit typed warnings (`reflect_apply_llm_skipped`, `reflect_apply_llm_vet_failed`, `reflect_apply_graph_store_not_configured`, `reflect_apply_dry_run`, `reflect_apply_no_writes`) and fall back to the deterministic plan.
    - `@melandlabs/memory-store/search/apply-reflect` — `applyReflectedPlan(input)` exposes the write-back loop with the same `peerFilter` / `tiers` / `limit` / `threshold` surface as `reflect()`.
    - `@melandlabs/memory-store/memory-store-graph` — `attachMemoryGraphStore(store, { storage, ownerScope })` is the opt-in wiring point. Without it, `reflectWithPlan` still runs `deprecateRecords` against the storage adapter and emits a warning.
    - HTTP `POST /v1/reflect:apply` and MCP `memory.reflectWithPlan` expose the same surface.

  **Backward compatibility**

  - `FactType` is optional everywhere; v3 → v4 migration is non-destructive and v3 rows survive with `factType: undefined`.
  - `reflect()` (read-only) is unchanged. `MemoryStore.graphStore` and `MemoryStore.reflectWithPlan` are new optional fields.
  - `MemoryStoreConfig.graphStore?` is new and optional; not wiring it leaves `reflectWithPlan` in deprecate-only mode.
  - All new `UnifiedSearchDeps` slots are optional; existing call sites continue to work unchanged.
  - `applyReflectedConsolidationPlan` is idempotent — `persistPlan` deduplicates on `operationId` and `deprecateRecords` no-ops on already-deprecated rows.

### Patch Changes

- Updated dependencies [f31460c]
- Updated dependencies [aaf039a]
- Updated dependencies [e9cb443]
  - @melandlabs/memory-consolidation@0.5.0
  - @melandlabs/contracts@0.5.0

## 0.4.0

### Minor Changes

- f31460c: Two additive capabilities land together:

  - **`FactType` field** — atomic facts are now classified as `world`, `experience`, or `mental_model`. The `FactType` union lives in `@melandlabs/ai/memory/contracts`; it surfaces on `AtomicFactChunk.factType`, `MemoryRecord.factType`, and as the `factTypes` filter on `MemorySearchQuery` / `MemorySemanticRecallQuery`. The two `rawMessageToMemoryRecord` adapters (indexeddb + memory-store) carry the field through. IndexedDB bumps `DB_VERSION` 3 → 4 (additive `factType` index on `raw_messages`) and SQLite bumps `RAW_MESSAGES_SCHEMA_VERSION` 3 → 4 (additive `fact_type` column + partial index). Both migrations are idempotent and tolerate v3 rows whose `factType` is undefined.
  - **`store.reflectWithPlan()`** — agentic write-back loop. Gathers evidence via the same pipeline as `reflect()`, builds a rule-based consolidation plan (`MemoryConsolidationPlan`), optionally vets it through the configured LLM (`reasoning.complete`), and persists via `MemoryGraphStore.persistPlan` + `MemoryStorageAdapter.deprecateRecords`. Landing in three new modules:
    - `@melandlabs/ai-memory-consolidation/reflect-planner` — `buildReflectedConsolidationPlan` + `applyReflectedConsolidationPlan`. LLM vet only approves or vetoes existing entries — it never invents new operations. Failure modes emit typed warnings (`reflect_apply_llm_skipped`, `reflect_apply_llm_vet_failed`, `reflect_apply_graph_store_not_configured`, `reflect_apply_dry_run`, `reflect_apply_no_writes`) and fall back to the deterministic plan.
    - `@melandlabs/memory-store/search/apply-reflect` — `applyReflectedPlan(input)` exposes the write-back loop with the same `peerFilter` / `tiers` / `limit` / `threshold` surface as `reflect()`.
    - `@melandlabs/memory-store/memory-store-graph` — `attachMemoryGraphStore(store, { storage, ownerScope })` is the opt-in wiring point. Without it, `reflectWithPlan` still runs `deprecateRecords` against the storage adapter and emits a warning.
    - HTTP `POST /v1/reflect:apply` and MCP `memory.reflectWithPlan` expose the same surface.

  **Backward compatibility**

  - `FactType` is optional everywhere; v3 → v4 migration is non-destructive and v3 rows survive with `factType: undefined`.
  - `reflect()` (read-only) is unchanged. `MemoryStore.graphStore` and `MemoryStore.reflectWithPlan` are new optional fields.
  - `MemoryStoreConfig.graphStore?` is new and optional; not wiring it leaves `reflectWithPlan` in deprecate-only mode.
  - All new `UnifiedSearchDeps` slots are optional; existing call sites continue to work unchanged.
  - `applyReflectedConsolidationPlan` is idempotent — `persistPlan` deduplicates on `operationId` and `deprecateRecords` no-ops on already-deprecated rows.

### Patch Changes

- Updated dependencies [f31460c]
- Updated dependencies [aaf039a]
  - @melandlabs/memory-consolidation@0.4.0
  - @melandlabs/contracts@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - @melandlabs/env-config@0.4.0

## 0.3.0

### Minor Changes

- 351c6b2: Add an LLM-backed query rewriter and iterative recall planner to memory-store unified search, and a reasoning-backed memory layer exported from the opencontext facade. Also make LocalStorageProvider storage root injectable with hardened key sanitization, fix API error-body parsing, re-export createClaudeAgent/createCodexAgent factories from @melandlabs/ai/agent, and add vitest suites plus runnable tutorial examples across the monorepo.

### Patch Changes

- Updated dependencies
- Updated dependencies [351c6b2]
  - @melandlabs/memory-consolidation@0.3.0
  - @melandlabs/shared@0.3.0

## 0.2.1

### Patch Changes

- Release @melandlabs/opencontext 0.2.6 and publish updated workspace dependencies.
- Updated dependencies
  - @melandlabs/shared@0.2.1
  - @melandlabs/memory-consolidation@0.2.0

## 0.2.0

### Minor Changes

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

## 0.2.0

### Minor Changes

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

- Updated dependencies [1de8e1a]
  - @melandlabs/memory-consolidation@0.1.4
  - @melandlabs/shared@0.1.4
