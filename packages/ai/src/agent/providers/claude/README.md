# ClaudeAgent

`ClaudeAgent` is the Anthropic Claude Agent SDK adapter. It wraps the
`@anthropic-ai/claude-agent-sdk` `query()` function and exposes the same
provider-agnostic `IAgent` interface as the other OpenContext agents.

This implementation is the OpenContext reference port: it intentionally omits
host-coupled layers such as MCP server registries, supplemental-input hooks,
business-tools MCP, and host permission callbacks. Hosts that need those
concerns can layer them on top of the `Options` returned from
`createClaudeQueryOptions` before passing it to the SDK.

## When to use ClaudeAgent

Use ClaudeAgent when you want OpenContext to drive Claude Code. It supports the
full agentic loop with tools, planning, execution, and multi-turn conversations.

## Quick start

```typescript
import { createClaudeAgent } from "@melandlabs/ai/agent";

const agent = createClaudeAgent({
	provider: "claude",
	apiKey: process.env.ANTHROPIC_API_KEY,
	model: "claude-sonnet-4-20250514",
	workDir: "~/.opencontext",
});

for await (const message of agent.run("Review the auth module")) {
	console.log(message.type, message.content ?? message.message);
}
```

## Configuration

`AgentConfig` fields used by ClaudeAgent:

| Field | Description |
|---|---|
| `apiKey` | Anthropic API key or auth token. |
| `baseUrl` | Custom API base URL (e.g. gateway). |
| `model` | Model id passed to the SDK. |
| `workDir` | Base working directory for agent runs. |
| `providerConfig.claudeCodePath` | Path to the `claude` executable. Defaults to `claude`. |
| `providerConfig.settingSources` | `["user", "project"]` by default. |
| `providerConfig.settings` | Optional JSON-stringified SDK settings. |
| `providerConfig.allowedTools` | Tool allowlist passed to the SDK. |
| `providerConfig.maxTurns` | Maximum agent turns before stopping. |
| `providerConfig.includePartialMessages` | Enable partial message streaming. |

Run-time `AgentOptions` commonly used with ClaudeAgent:

| Option | Description |
|---|---|
| `systemPrompt` / `aiSoulPrompt` | Override the default system prompt. |
| `tools` | Tool preset or allowlist. |
| `allowedTools` / `disallowedTools` | Fine-grained tool control. |
| `permissionMode` | `"bypassPermissions"` or a stricter mode. |
| `abortController` | External abort signal. |

## Lifecycle

### `run(prompt, options?)`

Direct execution. ClaudeAgent:

1. Resolves and creates a session working directory.
2. Builds the SDK `Options` via `createClaudeQueryOptions`.
3. Calls `query({ prompt, options })` from the SDK.
4. Yields `AgentMessage` values until the turn completes or errors.

### `plan(prompt, options?)`

Planning phase. Tools are omitted and the sandbox is not used. Output is parsed
by `parsePlanningResponse` into either a `plan` or `direct_answer`.

### `execute(options)`

Executes a stored plan. The execution prompt is built with
`formatPlanForExecution` and passed to `run()`. After a successful execution the
plan is removed from memory.

## Message conversion

SDK messages are converted to `AgentMessage` by `convertClaudeSdkMessage`:

- `stream_event` with `text_delta` → `text`
- `stream_event` with `thinking_delta` → `reasoning`
- `stream_event` / `assistant` with tool calls → `tool_use`
- `user` with `tool_result` → `tool_result`
- `result` → `result` (with `usage` when present)

The converter de-duplicates content so consumers see a single coherent stream
even when the SDK surfaces the same content twice.

## Testing

ClaudeAgent tests are in `src/agent/providers/claude/index.test.ts`. They mock
the SDK's `query` function so the tests run without a real Claude Code
installation.

```bash
cd packages/ai
pnpm test src/agent/providers/claude/index.test.ts
```

Test areas:

- Factory and provider identity.
- `run()` happy path with mocked SDK text output.
- `plan()` returning a plan or direct answer.
- `execute()` using a stored plan.
- Abort signal handling.
- SDK error conversion.
- Provider-config forwarding to SDK `query` options.
