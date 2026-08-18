/**
 * Shared helpers for the agent-runtime tutorials (`26-claude-agent-example.ts`,
 * `27-codex-agent-example.ts`).
 *
 * Both files wrap a CLI-based provider (`claude` / `codex exec --json`)
 * that streams the same `AgentMessage` shape defined in
 * `@melandlabs/ai/agent`. The helpers below centralise three things that
 * would otherwise be copy-pasted between the two tutorials:
 *
 *   - `hasCommand(bin)` — check whether a CLI binary is reachable on
 *     PATH (with a short timeout so the demo never hangs).
 *   - `printAgentMessage(msg)` — pretty-print an `AgentMessage` for the
 *     console, with a sensible per-type prefix and a content slice so
 *     long LLM streams do not flood the terminal.
 *   - `collectAgentMessages(generator, label)` — drain an async
 *     generator into an array while printing each message under a
 *     labelled section header.
 */

import { spawnSync } from "node:child_process";
import type { AgentMessage } from "@melandlabs/ai/agent";

/**
 * Return true when `bin --version` exits 0 on PATH. Uses `shell: true`
 * so users on macOS / WSL pick up the binary through the user's login
 * shell even when the agent process inherits a constrained `PATH`.
 */
export function hasCommand(bin: string, timeoutMs = 5000): boolean {
	const result = spawnSync(bin, ["--version"], {
		shell: true,
		stdio: "ignore",
		timeout: timeoutMs,
	});
	return result.status === 0;
}

/**
 * Pretty-print one `AgentMessage` from a Claude / Codex agent stream.
 * Text and reasoning content is sliced to keep the terminal readable;
 * tool results are summarised by name + a short preview.
 */
export function printAgentMessage(msg: AgentMessage): void {
	const slice = (s: string | undefined, max = 120): string => (s ?? "").slice(0, max);
	switch (msg.type) {
		case "session":
			console.log(`[session] ${msg.sessionId}`);
			break;
		case "text":
			console.log(`[text] ${slice(msg.content)}`);
			break;
		case "reasoning":
			console.log(`[reasoning] ${slice(msg.content)}`);
			break;
		case "tool_use":
			console.log(`[tool_use] ${msg.name}`);
			break;
		case "tool_result":
			console.log(`[tool_result] ${msg.name}: ${slice(String(msg.result ?? ""))}`);
			break;
		case "result":
			console.log(`[result] ${msg.usage?.inputTokens ?? "?"} in / ${msg.usage?.outputTokens ?? "?"} out`);
			break;
		case "error":
			console.log(`[error] ${msg.message}`);
			break;
		case "done":
			console.log("[done]");
			break;
		default:
			console.log(`[${(msg as AgentMessage).type}]`);
	}
}

/**
 * Drain an async generator of `AgentMessage` values into an array while
 * printing each one under `── <label> ──`. Returns the collected messages
 * so callers can assert on the result (e.g. that a `plan` or `text`
 * message was produced).
 */
export async function collectAgentMessages(
	generator: AsyncGenerator<AgentMessage>,
	label: string,
): Promise<AgentMessage[]> {
	console.log(`\n--- ${label} ---`);
	const messages: AgentMessage[] = [];
	for await (const msg of generator) {
		messages.push(msg);
		printAgentMessage(msg);
	}
	return messages;
}
