# Agent SDK Abstraction Layer

This package provides a provider-agnostic abstraction over multiple agent
runtimes. It lets host applications call `run()`, `plan()`, and `execute()`
without knowing whether the underlying provider is Claude Code, OpenAI Codex,
OpenCode, OpenClaw, Hermes, or a native runtime.

## Core concepts

- **`IAgent`** (`types.ts`) — the interface every provider must implement.
- **`BaseAgent`** (`base.ts`) — common session management, plan storage, and
  shared helpers such as language directives and output-style instructions.
- **`AgentPlugin`** (`plugin.ts`) — metadata + factory used to register a
  provider in the runtime registry.
- **`AgentConfig` / `AgentOptions`** (`types.ts`) — configuration objects passed
  when constructing or invoking an agent.

## Supported providers

| Provider | Entry point | Planning | Streaming | Sandbox |
|---|---|---|---|---|
| Claude Code | `providers/claude` | yes | yes | yes |
| Codex CLI | `providers/codex` | yes | yes | yes |
| OpenCode | `providers/opencode` | yes | yes | no |
| OpenClaw | `providers/openclaw` | yes | yes | no |
| Hermes | `providers/hermes` | yes | yes | no |
| Standalone | `providers/standalone.ts` | no | no | no |
| Native runtime | `native-runner` | yes | yes | optional |

## Three-phase lifecycle

All providers implement the same lifecycle:

1. **`run(prompt, options?)`** — direct execution. The agent receives a prompt,
   may use tools, and yields a stream of `AgentMessage` values ending with
   `{ type: "done" }`.
2. **`plan(prompt, options?)`** — planning only. The agent returns either a
   `TaskPlan` (`{ type: "plan" }`) or a direct answer (`{ type: "direct_answer" }`)
   without mutating the workspace.
3. **`execute(options)`** — execute a previously stored plan. The plan can be
   passed directly (`options.plan`) or looked up by id (`options.planId`).

```typescript
import { createCodexAgent } from "@melandlabs/ai/agent";

const agent = createCodexAgent({
	provider: "codex",
	model: "gpt-4.1",
	workDir: "~/.opencontext",
});

// Direct execution
for await (const message of agent.run("List the files in the workspace")) {
	console.log(message);
}

// Two-phase execution
for await (const message of agent.plan("Refactor the auth module")) {
	if (message.type === "plan") {
		console.log("Plan:", message.plan);
	}
}

for await (const message of agent.execute({
	planId: "plan-id-from-previous-step",
	originalPrompt: "Refactor the auth module",
})) {
	console.log(message);
}
```

## AgentMessage types

The stream yielded by every provider uses the `AgentMessage` union defined in
`types.ts`. Common types include:

- `session` — run/session identity.
- `text` / `reasoning` — model-generated content.
- `tool_use` / `tool_result` — tool invocation and result.
- `result` — final turn summary, often with token `usage`.
- `error` — terminal failure.
- `done` — stream terminator.
- `plan` / `direct_answer` — planning-phase outputs.
- `retry` — transient retry notice (not terminal).

## Adding a new provider

1. Implement `BaseAgent` in a new directory under `providers/`.
2. Export a factory function such as `createMyAgent(config)`.
3. Define plugin metadata with `defineAgentPlugin`.
4. Register the plugin in the agent registry.

```typescript
import { BaseAgent, defineAgentPlugin } from "@melandlabs/ai/agent";
import type { AgentConfig, AgentMessage } from "@melandlabs/ai/agent/types";

export class MyAgent extends BaseAgent {
	readonly provider = "my-provider";

	async *run(prompt: string): AsyncGenerator<AgentMessage> {
		yield { type: "session", sessionId: "session-1" };
		yield { type: "text", content: `Echo: ${prompt}` };
		yield { type: "done" };
	}

	async *plan(): AsyncGenerator<AgentMessage> {
		throw new Error("Planning not supported");
	}

	async *execute(): AsyncGenerator<AgentMessage> {
		throw new Error("Execution not supported");
	}
}

export const myAgentPlugin = defineAgentPlugin({
	metadata: {
		type: "my-provider",
		name: "My Agent",
		supportsPlan: false,
		supportsStreaming: true,
		supportsSandbox: false,
	},
	factory: (config) => new MyAgent(config),
});
```

## Running tests

Tests live next to the source files under `src/**/*.test.ts`.

```bash
cd packages/ai
pnpm test
```

Run a single provider's tests:

```bash
cd packages/ai
pnpm test src/agent/providers/codex/index.test.ts
pnpm test src/agent/providers/claude/index.test.ts
```
