---
"@melandlabs/ai": minor
---

HTTP-first `BaseAgent.compactContext` with OpenAI- and Anthropic-compatible wire support. Preserves the existing `providerConfig.compactor` slot as an explicit opt-out (callers that already supply a `Compactor` are unaffected). When no in-process compactor is wired, `compactContext` now POSTs the conversation to an HTTP endpoint and returns the resulting summary as a `CompactContextResult`.

Configuration is two-layered (per-call input overrides win over per-agent defaults):

- `CompactContextInput` gains `userToken` (`Authorization: Bearer ...`), `compactionEndpoint`, and `extraHeaders` (merged LAST — can override `Authorization` and base headers).
- `providerConfig` gains `compactionEndpoint?: { baseUrl, model?, headers?, protocol?: "anthropic" | "openai" }` and `compactionUserToken?: string` (defaults populated at agent construction).
- Env fallbacks: `COMPACTION_HTTP_ENDPOINT` / `COMPACTION_HTTP_USER_TOKEN`.

A new `packages/ai/src/agent/compaction/http-compactor.ts` module ships the wire client. Protocol selection follows `endpoint.protocol`:

- `"anthropic"` (default) — `POST {baseUrl}/v1/messages`, `anthropic-version: 2023-06-01` header, `system` field; parses `content[].text` and `usage.{input,output}_tokens`.
- `"openai"` — `POST {baseUrl}/v1/chat/completions`, system prompt prepended as the first message in `messages[]`; parses `choices[0].message.content` and `usage.{prompt,completion}_tokens`.

`runWithAutoCompactCore` threads `compactionEndpoint` / `compactionUserToken` into the auto-compact recovery loop (reactive overflow recovery + proactive threshold-triggered compaction); `runWithAutoCompact` and the standalone `IAgent` wrapper contract are otherwise unchanged.

Header merge order (matches the JSDoc on `extraHeaders`): protocol defaults (Content-Type, anthropic-version) → `compactionEndpoint.headers` (agent-level) → `Authorization: Bearer <userToken>` (when set) → `input.extraHeaders` (per-call, LAST — can override anything above).

Hosts that want Alloomi's `/api/ai/v1/messages` to be the default just populate `providerConfig.compactionEndpoint.baseUrl` + `providerConfig.compactionUserToken` at agent construction — no dedicated `/compact` route required.