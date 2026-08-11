/**
 * Claude Code SDK query options assembly.
 *
 * Pure SDK-options projection for `query()` — the opencontext reference port
 * deliberately omits the host-coupled concerns that lived alongside this
 * helper in the openloomi tree (MCP server attachment, supplemental-input
 * hooks, business-tools registry, host permission callbacks). Consumers that
 * need those can layer them on top of the {@link createClaudeQueryOptions}
 * output by mutating the returned `Options` object before passing it to
 * `query()`.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";

import type { AgentConfig, AgentOptions } from "../../types";

// Baseline tool surface for Claude Code sessions. Hosts that need extra tools
// should append them on top of this list.
export const DEFAULT_ALLOWED_TOOLS = [
	"Read",
	"Edit",
	"Write",
	"Glob",
	"Grep",
	"Bash",
	"WebSearch",
	"WebFetch",
	"Skill",
	"Task",
	"LSP",
	"TodoWrite",
];

export interface CreateClaudeQueryOptionsInput {
	sessionId: string;
	cwd: string;
	settingSources: ("user" | "project")[];
	settings?: string;
	allowedTools: string[];
	agentOptions?: Pick<AgentOptions, "permissionMode" | "disallowedTools">;
	abortController: AbortController;
	env: Record<string, string>;
	config: AgentConfig;
	claudeCodePath: string;
	systemPrompt: string;
	tools?: Options["tools"];
	maxTurns?: number;
	includePartialMessages?: boolean;
	spawnClaudeCodeProcess: NonNullable<Options["spawnClaudeCodeProcess"]>;
}

/**
 * Assemble the common Claude SDK query options used by run/plan/execute.
 *
 * The helper returns an `Options` object suitable for direct consumption by
 * the SDK's `query()`. Callers may post-process the result to add MCP servers,
 * hooks, or permission callbacks without having to re-derive the baseline
 * fields below.
 */
export function createClaudeQueryOptions({
	cwd,
	settingSources,
	settings,
	allowedTools,
	agentOptions,
	abortController,
	env,
	config,
	claudeCodePath,
	systemPrompt,
	tools,
	maxTurns,
	includePartialMessages,
	spawnClaudeCodeProcess,
}: CreateClaudeQueryOptionsInput): Options {
	const effectivePermissionMode = agentOptions?.permissionMode ?? "bypassPermissions";

	return {
		cwd,
		// `tools` can be omitted for plan-only calls; run/execute use the Claude
		// Code preset so the SDK exposes file, shell, and search tools.
		...(tools ? { tools } : {}),
		allowedTools,
		settingSources,
		settings,
		// Keep bypassPermissions as the historical default. Any stricter mode
		// registers canUseTool at the call site to keep desktop UI prompts
		// functional.
		permissionMode: effectivePermissionMode,
		...(agentOptions?.disallowedTools?.length ? { disallowedTools: agentOptions.disallowedTools } : {}),
		allowDangerouslySkipPermissions: effectivePermissionMode === "bypassPermissions",
		abortController,
		env,
		model: config.model,
		pathToClaudeCodeExecutable: claudeCodePath,
		...(maxTurns !== undefined ? { maxTurns } : {}),
		...(includePartialMessages !== undefined ? { includePartialMessages } : {}),
		// The SDK does not wire its stderr callback when a custom spawner is
		// supplied, so per-call sites capture stderr through the spawner.
		spawnClaudeCodeProcess,
		systemPrompt,
	} as Options;
}
