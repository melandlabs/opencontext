/**
 * OpenCode CLI provider metadata.
 *
 * @see ./command.ts for how providerConfig maps to the spawned CLI.
 */

import type { AgentProviderMetadata } from "../../plugin";

export const OPENCODE_CONFIG_SCHEMA = {
	type: "object",
	properties: {
		model: {
			type: "string",
			description: "OpenCode model in provider/model format",
		},
		workDir: {
			type: "string",
			description: "Working directory for OpenCode file operations",
		},
		providerConfig: {
			type: "object",
			properties: {
				opencodePath: {
					type: "string",
					description: "Path to the opencode CLI executable",
				},
				agent: {
					type: "string",
					description: "OpenCode agent name to use",
				},
				files: {
					type: "array",
					items: { type: "string" },
					description: "Files to attach to the OpenCode message",
				},
				allowAutoApprove: {
					type: "boolean",
					default: false,
					description: "Allow passing --auto when the host permissionMode is bypassPermissions",
				},
				timeoutMs: {
					type: "number",
					description: "Maximum OpenCode CLI runtime in milliseconds",
				},
				env: {
					type: "object",
					additionalProperties: { type: "string" },
					description: "Extra env vars merged into the spawned CLI",
				},
			},
		},
	},
} as const;

export const OPENCODE_METADATA: AgentProviderMetadata = {
	type: "opencode",
	name: "OpenCode CLI",
	version: "1.0.0",
	description: "OpenCode CLI runtime integration using opencode run JSON events.",
	configSchema: OPENCODE_CONFIG_SCHEMA,
	builtin: true,
	supportsPlan: true,
	supportsStreaming: true,
	supportsSandbox: false,
	tags: ["opencode", "cli", "coding-agent"],
};
