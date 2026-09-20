---
"@melandlabs/ai": minor
"@melandlabs/opencontext": minor
---

Transparent context-overflow recovery for agent runs. `@melandlabs/ai` promotes `compactContext` to the `IAgent` surface (default implementation on `BaseAgent`, backed by `AgentConfig.providerConfig.compactor`) and wraps `BaseAgent.run` with an overflow-recovery loop: on a `kind: "context_overflow"` error the prior `options.conversation` is summarized via `agent.compactContext(...)` and the run is re-issued with the summary prefixed as a `[carry-forward]` block, bounded by a retry budget. A synthetic `type: "retry"` notice (`[auto-compact]` message prefix) is yielded before the retry stream so hosts can drop the aborted attempt's partial output; compaction failures and exhausted budgets surface the original overflow error verbatim. Also exports `runWithAutoCompact` (standalone wrapper for tests / external `IAgent` stubs), `runCompactor` (in-process compaction primitive), and the `Compactor` / `CompactContextInput` / `CompactContextResult` types. Only providers that classify overflow as `context_overflow` (currently `StandaloneAgent`) trigger recovery; `plan()` / `execute()` are not wrapped.

`@melandlabs/opencontext` adds the `createCompactor` / `createDisabledCompactor` factories (hosts attach the result to `providerConfig.compactor`) and extracts a shared `createLanguageModel` LLM factory (`createLanguageModel` / `detectProviderType` / `normalizeAnthropicBaseUrl` / `readLLMEnv`) that now backs both `createCompactor` and `createMemoryReasoningProviders`, supporting Anthropic-compatible endpoints in addition to OpenAI-compatible ones. Adds `@ai-sdk/anthropic` aligned with the version used by `@melandlabs/ai`.

Follow-up hardening, modeled on the context-compaction designs of Codex CLI, OpenClaw, Hermes Agent, and OpenHands/Cline:

- **Proactive trigger**: `providerConfig.compactThresholdTokens` compacts before the run once the estimated conversation size crosses the threshold, instead of waiting for an overflow error.
- **Keep-recent-tail**: the retry prompt keeps the newest messages verbatim up to `providerConfig.compactKeepRecentTokens` (default 4000) alongside the carry-forward summary.
- **Baseline回流**: `AgentOptions.onCompactionBaseline` hands hosts a structured replacement history (`[system: carry-forward summary, ...verbatim tail]`) so subsequent turns stop re-sending the oversized original conversation.
- **Resilience**: compaction LLM failures fall back once to deterministic truncation (oldest half dropped, no LLM required); the summarizer retries with its oldest messages dropped when the compaction call itself overflows; `maxSummaryTokens` (default 2000) hard-caps summary length.
