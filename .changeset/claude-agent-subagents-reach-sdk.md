---
"@melandlabs/ai": minor
---

Forward host-declared subagents to the Claude Agent SDK. `AgentOptions.subagents` was a documented part of the public surface, but `ClaudeAgent` never passed it to the SDK — a host that declared subagents had them silently dropped, and the main agent could not invoke them. `createClaudeQueryOptions` now projects the definitions onto the SDK's `agents` option, and the provider forwards `options.subagents` through.

The projection is field-gated against `AgentDefinition`. Only `description`, `prompt`, `tools`, `disallowedTools`, `model`, `maxTurns`, and `effort` are emitted; anything else a host attaches is dropped rather than forwarded, since an unrecognized key reaches the Claude Code CLI verbatim and invalidates the whole `agents` payload. Hosts are plain JS callers, so this runtime guard is the only thing standing between a stray field and a rejected request. The field list is checked against `keyof AgentDefinition` at compile time, so an SDK rename surfaces as a type error rather than a silent pass-through. When no subagents are declared the `agents` key is omitted entirely rather than sent as an empty record.

Also adds two optional fields to `AgentSubagentDefinition`:

- `maxTurns?: number` — per-subagent cap on agentic turns (API round-trips).
- `effort?: "low" | "medium" | "high" | "xhigh" | "max" | number` — per-subagent reasoning effort; omit to inherit the parent's. Mirrors the SDK's `AgentDefinition["effort"]` and, unlike the neighbouring `model` alias union, is intentionally *not* widened with `| string` so typos are caught at compile time.

The union is declared literally rather than derived from `AgentDefinition["effort"]` because `agent/types.ts` is the provider-agnostic types module and imports nothing from `@anthropic-ai/claude-agent-sdk`; `AgentSubagentDefinition` is shared across the Claude, standalone, and Codex providers.

Out of scope (left for follow-ups):

- `withClaudeCodeReadToolWorkaroundForSubagents` remains host-applied. Now that subagents actually reach the SDK, a host that forgets to call it will send subagent prompts that trip the Claude Code Read `pages` validation bug (#2679). Whether the provider should own that injection is a pre-existing host/provider split and was left unchanged here.
- Equivalent subagent passthrough for the standalone and Codex providers, which do not read `subagents` at all.
