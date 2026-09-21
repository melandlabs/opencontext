---
"@melandlabs/ai": minor
---

`StandaloneAgent` now honors explicit configuration and an OpenAI-compatible wire protocol.

Previously `StandaloneAgent.runCore` only routed model construction through `createDynamicModel`, which is hard-wired to `process.env.ANTHROPIC_*` and the global `setAIUserContext()` bag — every caller that wanted to pin credentials, forward a multi-turn conversation, or inject extra headers had to fork the agent locally. The agent now supports an explicit-credential path that wins over env (`apiKey` + `baseUrl` on `AgentConfig`), threads `options.systemPrompt` (takes precedence over `aiSoulPrompt`) / `options.conversation` (leading `ModelMessage` entries + the prompt appended as the trailing user message) / `options.extraHeaders` (forwarded as `headers` only when present) through `generateText`, and supports both Anthropic- and OpenAI-compatible wire protocols via a `providerType` discriminator on `providerConfig` (`"anthropic_compatible"` is the default).

Surface area:

- `AgentConfig.providerConfig.providerType?: "anthropic_compatible" | "openai_compatible"` — opt the explicit path into an OpenAI-compatible endpoint.
- New `createStandaloneAgent(config)` factory mirroring `createClaudeAgent` / `createCodexAgent` for callers that want a `StandaloneAgent` without registering a plugin.
- New subpath export `@melandlabs/ai/agent/standalone-model` exporting `createStandaloneModel` and `StandaloneProviderType` (re-exported from `_internal/standalone-model.ts`).

Implementation:

- New `packages/ai/src/agent/providers/_internal/standalone-model.ts` (`createStandaloneModel`) — when both `apiKey` and `baseUrl` are non-empty, builds an `Anthropic`- or OpenAI-compatible client directly (`createAnthropic(...).languageModel(...)` or `createOpenAICompatible({ baseURL, apiKey, name: "standalone-model" }).chatModel(...)`), skipping env and `AIUserContext`. Falls through to `createDynamicModel` otherwise, so existing callers keep working unchanged. BaseUrl is normalized so it always ends with `/v1` to match the existing `getValidatedEnv` behaviour.

Out of scope (left for follow-ups):

- Replacing `PlatformStandaloneAgent` in alloomi (depends on a publish of this change).
- Mapping `ConversationMessage.imagePaths` to AI SDK image parts.
- Per-run `options.model` override on the standalone provider.
- Adding the same config-injection treatment to other providers (Codex, Hermes, OpenClaw, OpenCode).
