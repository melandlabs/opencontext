---
"@melandlabs/ai": major
---

**Breaking**: `StandaloneAgent` now requires explicit credentials (`apiKey` + `baseUrl`) on `AgentConfig`. The previous env + `setAIUserContext()` fallback path through `createDynamicModel` has been removed.

Previously `StandaloneAgent.runCore` routed model construction through `createDynamicModel`, which is hard-wired to `process.env.ANTHROPIC_*` and the global `setAIUserContext()` bag — every caller that wanted to pin credentials, forward a multi-turn conversation, or inject extra headers had to fork the agent locally. The agent now supports an explicit-credential path that **replaces** the env fallback entirely:

- `apiKey` + `baseUrl` on `AgentConfig` are mandatory. The internal `createStandaloneModel` helper throws an explicit error when either is missing, and `StandaloneAgent.runCore` surfaces the message to the caller as an `upstream_error` `AgentMessage`.
- `options.systemPrompt` (takes precedence over `aiSoulPrompt`) / `options.conversation` (leading `ModelMessage` entries + the prompt appended as the trailing user message) / `options.extraHeaders` (forwarded as `headers` only when present) are now threaded through `generateText`.
- `options.conversation[].imagePaths` — user-role entries with one or more `imagePaths` are now surfaced as multimodal AI SDK `UserContent` arrays (`text` part + one `image` part per path). Reads happen via `node:fs/promises.readFile` with parallel `Promise.all`; supported extensions are `.png`, `.jpg` / `.jpeg`, `.gif`, `.webp`. Other extensions, missing files, and whitespace-only entries surface as `upstream_error` `AgentMessage`s. Non-user roles and user messages without `imagePaths` keep the legacy `{ role, content: string }` shape.
- `AgentConfig.providerConfig.providerType?: "anthropic_compatible" | "openai_compatible"` — opt the explicit path into an OpenAI-compatible endpoint.
- New `createStandaloneAgent(config)` factory mirroring `createClaudeAgent` / `createCodexAgent` for callers that want a `StandaloneAgent` without registering a plugin.
- New subpath exports:
  - `@melandlabs/ai/agent/standalone-model` — `createStandaloneModel` and `StandaloneProviderType` (re-exported from `_internal/standalone-model.ts`).
  - `@melandlabs/ai/agent/standalone-images` — `readImageParts` and `buildConversationMessages` (re-exported from `_internal/standalone-images.ts`).

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

Hosts that need to attach an image to a single-turn call now pass `imagePaths` on the `conversation` entry instead of forking the agent locally:

```ts
await agent.run("describe this screenshot", {
  conversation: [
    { role: "user", content: "see attached", imagePaths: ["/abs/path/screen.png"] },
  ],
});
```

## Implementation

- `packages/ai/src/agent/providers/_internal/standalone-model.ts` (`createStandaloneModel`) — throws when either `apiKey` or `baseUrl` is missing (or whitespace-only). When both are present, builds an Anthropic- or OpenAI-compatible client directly (`createAnthropic(...).languageModel(...)` or `createOpenAICompatible({ baseURL, apiKey, name: "standalone-model" }).chatModel(...)`). The baseUrl is normalized so it always ends with `/v1` to match the existing `getValidatedEnv` behaviour. The helper intentionally does not take `isNativeMode`, fall back to `createDynamicModel`, or honour `setAIUserContext()` / `process.env` — those concerns are now entirely the caller's responsibility.
- `packages/ai/src/agent/providers/_internal/standalone-images.ts` (`readImageParts` + `buildConversationMessages`) — reads image attachments with `node:fs/promises.readFile` in parallel, detects a supported MIME type from the file extension, and emits AI SDK `ImagePart` entries (`{ type: "image", image: <base64>, mediaType }`). User messages with `imagePaths` become multimodal `UserContent` arrays; everything else keeps the legacy string-content shape. Reading failures (missing file, unsupported extension, whitespace-only path) flow through the existing `try` / `catch` in `runCore` as `upstream_error` `AgentMessage`s.
- `StandaloneAgent.runCore` no longer imports `createDynamicModel`. Both `buildConversationMessages` and `createStandaloneModel` are called inside the existing `try` block so any throw (missing credentials, unreadable image, unsupported extension) is surfaced to the caller as an `upstream_error` `AgentMessage`.

Out of scope (left for follow-ups):

- Per-run `options.model` override on the standalone provider.
- Adding the same config-injection treatment to other providers (Codex, Hermes, OpenClaw, OpenCode).