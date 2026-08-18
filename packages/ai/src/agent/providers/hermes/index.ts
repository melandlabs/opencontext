/**
 * Hermes agent — {@link AcpAgent} subclass that drives the Hermes CLI's
 * `acp` subcommand over stdio JSON-RPC.
 *
 * Hermes is one of the two reference ACP providers shipped with the SDK.
 * It supports `session/set_model`, so the runtime can switch the model
 * mid-session via {@link AcpRuntimeDefinition.supportsSetModel}.
 */

import { defineAgentPlugin } from "../../plugin";
import type { AgentPlugin } from "../../plugin";
import type { AgentConfig } from "../../types";
import { AcpAgent, type AcpRuntimeDefinition } from "../acp/agent";
import { buildHermesAcpCommand, normalizeHermesProviderConfig } from "./command";
import { HERMES_METADATA } from "./metadata";

const HERMES_ACP_RUNTIME: AcpRuntimeDefinition = {
	provider: "hermes",
	displayName: "Hermes",
	buildCommand: buildHermesAcpCommand,
	normalizeProviderConfig: normalizeHermesProviderConfig,
	supportsSetModel: true,
	formatModelId: (model, providerConfig) => {
		const provider = normalizeHermesProviderConfig(providerConfig).env?.HERMES_INFERENCE_PROVIDER;
		return provider && !model.startsWith(`${provider}:`) ? `${provider}:${model}` : model;
	},
};

export class HermesAgent extends AcpAgent {
	constructor(config: AgentConfig) {
		super(config, HERMES_ACP_RUNTIME);
	}
}

export function createHermesAgent(config: AgentConfig): HermesAgent {
	return new HermesAgent(config);
}

export const hermesAgentPlugin: AgentPlugin = defineAgentPlugin({
	metadata: HERMES_METADATA,
	factory: createHermesAgent,
});
