export const SELECTABLE_AGENT_RUNTIMES = ["claude", "codex", "openclaw", "opencode", "hermes"] as const;

export type SelectableAgentRuntime = (typeof SELECTABLE_AGENT_RUNTIMES)[number];

export type AgentRuntimeSetupStatus = "ready" | "login_required" | "not_installed" | "unverified";

export type AgentRuntimePublicProbe = {
	provider: SelectableAgentRuntime;
	installed: boolean;
	authenticated: boolean | null;
	ready: boolean;
	readyVia: "cli" | "api" | null;
	status: AgentRuntimeSetupStatus;
	version: string | null;
	reason:
		| "READY"
		| "CLI_UNAVAILABLE"
		| "VERSION_FAILED"
		| "VERSION_TIMEOUT"
		| "AUTH_REQUIRED"
		| "AUTH_UNAVAILABLE"
		| "AUTH_TIMEOUT"
		| "PROBE_FAILED";
};

export type AgentRuntimeSettingsResponse = {
	editable: boolean;
	preference: SelectableAgentRuntime | null;
	effective: {
		provider: string;
		source: "preference" | "environment" | "default";
	};
	platform: "windows" | "macos" | "linux";
	runtimes: Record<SelectableAgentRuntime, AgentRuntimePublicProbe> | null;
};

export function canSaveAgentRuntime(
	state: AgentRuntimeSettingsResponse,
	draft: SelectableAgentRuntime | null,
): boolean {
	return Boolean(
		state.editable && draft && draft !== state.effective.provider && state.runtimes?.[draft].ready,
	);
}
