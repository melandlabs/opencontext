/**
 * OpenClaw agent — {@link AcpAgent} subclass that drives the OpenClaw
 * Gateway CLI's `acp` subcommand over stdio JSON-RPC.
 *
 * OpenClaw is a gateway-backed browser-agent bridge: it accepts session,
 * token, and password file paths rather than env-var credentials, and can
 * require/reset an existing session per call.
 */

import { defineAgentPlugin } from "../../plugin";
import type { AgentPlugin } from "../../plugin";
import type { AgentConfig } from "../../types";
import { AcpAgent, type AcpRuntimeDefinition } from "../acp/agent";
import { buildOpenClawAcpCommand, normalizeOpenClawProviderConfig } from "./command";
import { OPENCLAW_METADATA } from "./metadata";

const OPENCLAW_ACP_RUNTIME: AcpRuntimeDefinition = {
	provider: "openclaw",
	displayName: "OpenClaw",
	buildCommand: buildOpenClawAcpCommand,
	normalizeProviderConfig: normalizeOpenClawProviderConfig,
};

export class OpenClawAgent extends AcpAgent {
	constructor(config: AgentConfig) {
		super(config, OPENCLAW_ACP_RUNTIME);
	}
}

export function createOpenClawAgent(config: AgentConfig): OpenClawAgent {
	return new OpenClawAgent(config);
}

export const openclawAgentPlugin: AgentPlugin = defineAgentPlugin({
	metadata: OPENCLAW_METADATA,
	factory: createOpenClawAgent,
});
