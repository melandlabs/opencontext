---
"@melandlabs/ai": major
---

**Breaking**: `StandaloneAgent` now requires explicit credentials (`apiKey` + `baseUrl`) on `AgentConfig`. The previous env + `setAIUserContext()` fallback path through `createDynamicModel` has been removed.

Previously `StandaloneAgent.runCore` routed model construction through `createDynamicModel`, which is hard-wired to `process.env.ANTHROPIC_*` and the global `setAIUserContext()` bag — every caller that wanted to pin credentials, forward a multi-turn conversation, or inject extra headers had to fork the agent locally. The agent now supports an explicit-credential path that **replaces** the env fallback entirely:

- `apiKey` + `baseUrl` on `AgentConfig` are mandatory. The internal `createStandaloneModel` helper throws an explicit error when either is missing, and `StandaloneAgent.runCore` surfaces the message to the caller as an `upstream_error` `AgentMessage`.
- `providerConfig.isNativeMode` is no longer read — explicit `baseUrl` already encodes the destination (local proxy vs external API).
- `options.systemPrompt` (takes precedence over `aiSoulPrompt`) / `options.conversation` (leading `ModelMessage` entries + the prompt appended as the trailing user message) / `options.extraHeaders` (forwarded as `headers` only when present) are now threaded through `generateText`.
- `AgentConfig.providerConfig.providerType?: "anthropic_compatible" | "openai_compatible"` — opt the explicit path into an OpenAI-compatible endpoint.
- New `createStandaloneAgent(config)` factory mirroring `createClaudeAgent` / `createCodexAgent` for callers that want a `StandaloneAgent` without registering a plugin.
- New subpath export `@melandlabs/ai/agent/standalone-model` exporting `createStandaloneModel` and `StandaloneProviderType` (re-exported from `_internal/standalone-model.ts`).

## Migration

Callers that previously relied on env vars or `setAIUserContext()` to drive `StandaloneAgent` must now pass credentials explicitly:

```ts
// Before — relied on ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL or
// setAIUserContext() to supply credentials.
const agent = new StandaloneAgent({ provider: "standalone", model: "..." });
for await (const msg of agent.run("hello")) { /* ... */ }

// After — credentials are explicit. baseUrl gets `/v1` appended
// automatically.
const agent = new StandaloneAgent({
  provider: "standalone",
  model: "claude-sonnet-4-20250514",
  apiKey: process.env.ANTHROPIC_API_KEY!,
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
});
```

## Implementation

- `packages/ai/src/agent/providers/_internal/standalone-model.ts` (`createStandaloneModel`) — throws when either `apiKey` or `baseUrl` is missing (or whitespace-only). When both are present, builds an Anthropic- or OpenAI-compatible client directly (`createAnthropic(...).languageModel(...)` or `createOpenAICompatible({ baseURL, apiKey, name: "standalone-model" }).chatModel(...)`). The baseUrl is normalized so it always ends with `/v1` to match the existing `getValidatedEnv` behaviour. The helper intentionally does not take `isNativeMode`, fall back to `createDynamicModel`, or honour `setAIUserContext()` / `process.env` — those concerns are now entirely the caller's responsibility.
- `StandaloneAgent.runCore` no longer imports `createDynamicModel`; `resolveIsNativeMode` is removed. The model construction happens inside the existing `try` block so the throw is surfaced as an `upstream_error` `AgentMessage`.

Out of scope (left for follow-ups):

- Replacing `PlatformStandaloneAgent` in alloomi (depends on a publish of this change).
- Mapping `ConversationMessage.imagePaths` to AI SDK image parts.
- Per-run `options.model` override on the standalone provider.
- Adding the same config-injection treatment to other providers (Codex, Hermes, OpenClaw, OpenCode).
