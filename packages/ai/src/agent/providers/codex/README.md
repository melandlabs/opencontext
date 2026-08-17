# CodexAgent

`CodexAgent` is the OpenAI Codex CLI adapter. It spawns `codex exec --json`
and projects the resulting NDJSON event stream into the provider-agnostic
`AgentMessage` format used by the rest of OpenContext.

## When to use CodexAgent

Use CodexAgent when you want an agent that runs local shell commands and edits
files through OpenAI's Codex CLI. It is a good fit for coding tasks that need
terminal access and workspace mutations.

## Quick start

```typescript
import { createCodexAgent } from "@melandlabs/ai/agent";

const agent = createCodexAgent({
	provider: "codex",
	model: "gpt-4.1",
	workDir: "~/.opencontext",
	providerConfig: {
		codexPath: "codex", // or absolute path to the Codex CLI binary
	},
});

for await (const message of agent.run("Fix the failing tests")) {
	console.log(message.type, message.content ?? message.message);
}
```

## Configuration

`AgentConfig` fields used by CodexAgent:

| Field | Description |
|---|---|
| `model` | Model id passed to `codex exec -m`. |
| `workDir` | Base working directory for agent runs. |
| `providerConfig.codexPath` | Path to the `codex` executable. Defaults to searching `PATH`. |
| `providerConfig.profile` | Codex CLI profile (`-p`). |
| `providerConfig.sandbox` | Explicit sandbox mode override. |
| `providerConfig.fullAuto` | Whether to pass `--full-auto` when permissions allow it. |
| `providerConfig.skipGitRepoCheck` | Whether to pass `--skip-git-repo-check` (default `true`). |
| `providerConfig.timeoutMs` | Optional CLI timeout. |
| `providerConfig.env` | Extra environment variables for the Codex process. |

Sandbox modes:

- `read-only` — used automatically during `plan()`.
- `workspace-write` — default on Linux and Windows during `run()` / `execute()`.
- `danger-full-access` — default on macOS during `run()` / `execute()` so local
  services remain reachable.

## Lifecycle

### `run(prompt, options?)`

Executes a prompt directly. The command built is roughly:

```bash
codex exec --json -m <model> --sandbox <mode> --skip-git-repo-check
```

The prompt is written to stdin. The agent yields `session`, `text`, `tool_use`,
`tool_result`, and finally `result` + `done`.

### `plan(prompt, options?)`

Forces a `read-only` sandbox and disables `--full-auto`. The model can only
inspect the workspace and describe actions. The output is parsed into either:

- `{ type: "plan", plan: TaskPlan }` — a structured plan with steps.
- `{ type: "direct_answer", content: string }` — the task was simple enough to
  answer without a plan.

### `execute(options)`

Reads a stored plan (by `planId` or from `options.plan`) and runs it. The plan
is deleted from memory after a successful execution.

## Event mapping

Codex CLI emits NDJSON lines such as:

```json
{ "type": "thread.started", "thread_id": "thread-1" }
{ "type": "item.completed", "item": { "type": "agent_message", "text": "hello" } }
{ "type": "turn.completed", "usage": { "input_tokens": 9, "output_tokens": 4 } }
```

CodexAgent maps these to `AgentMessage`:

- `thread.started` → `session`
- `item.completed` with `agent_message` → `text`
- `item.completed` with `reasoning` → `reasoning`
- `item.completed` with `command_execution` → `tool_result`
- `item.completed` with `file_change` → `tool_result` summarizing the changes
- `turn.completed` → `result` (with usage when numeric)
- transient transport errors (`Reconnecting...`, `falling back to HTTP`) → `retry`
- fatal CLI exit errors → `error`

## Handling interruptions

When a run exceeds `timeoutMs`, CodexAgent emits a structured interruption error
starting with `__CODEX_INTERRUPTED__`. The error payload contains the workspace
path and any artifacts completed before the timeout, allowing a follow-up run to
continue from the same workspace.

## Testing

CodexAgent tests are in `src/agent/providers/codex/index.test.ts`. They use a
fake Codex script (the Node.js executable) so no real Codex CLI installation is
required.

```bash
cd packages/ai
pnpm test src/agent/providers/codex/index.test.ts
```

Key test areas:

- Command-line argument construction (`buildCodexRunCommand`).
- Sandbox mode resolution per platform and phase.
- NDJSON parsing and event mapping.
- Transport retry/fallback classification.
- Run/plan/execute flow with fake scripts.
- UTF-8 chunk splitting.
- Interruption and continuation behavior.
