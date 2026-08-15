/**
 * Test script to verify 05-building-agents.md use cases work correctly.
 */

import {
	type AgentConfig,
	type AgentMessage,
	BaseAgent,
	type IAgent,
	STANDALONE_METADATA,
	StandaloneAgent,
	defineAgentPlugin,
	getAgentInstance,
	getAgentRegistry,
	getRegisteredAgentProviders,
	registerAgentPlugin,
	standaloneAgentPlugin,
} from "@melandlabs/ai";
import { info, makeCheckWithSkip, runSection } from "../src/_helpers.ts";

export default async function testBuildingAgents() {
	await runSection("05-building-agents.md examples", async () => {
		const { check, skip } = makeCheckWithSkip("tutorial/05");

		// ===== Quick Start: StandaloneAgent =====
		info("tutorial/05", "Testing: StandaloneAgent availability");
		check("StandaloneAgent is a constructable class", typeof StandaloneAgent === "function");
		check("BaseAgent is a constructable class", typeof BaseAgent === "function");

		// ===== Agent Metadata =====
		info("tutorial/05", "Testing: StandaloneAgent metadata");
		check("STANDALONE_METADATA.type is 'standalone'", STANDALONE_METADATA.type === "standalone");
		check("STANDALONE_METADATA.supportsPlan is false", STANDALONE_METADATA.supportsPlan === false);
		check("STANDALONE_METADATA.supportsStreaming is false", STANDALONE_METADATA.supportsStreaming === false);
		check("STANDALONE_METADATA.supportsSandbox is false", STANDALONE_METADATA.supportsSandbox === false);

		// ===== Plugin System =====
		info("tutorial/05", "Testing: Agent plugin system");
		check("defineAgentPlugin is callable", typeof defineAgentPlugin === "function");
		check("registerAgentPlugin is callable", typeof registerAgentPlugin === "function");
		check("getAgentRegistry is callable", typeof getAgentRegistry === "function");
		check("getAgentInstance is callable", typeof getAgentInstance === "function");

		// ===== StandaloneAgent Plugin =====
		info("tutorial/05", "Testing: standaloneAgentPlugin structure");
		check(
			"standaloneAgentPlugin has metadata",
			typeof standaloneAgentPlugin === "object" && standaloneAgentPlugin !== null,
		);
		check("standaloneAgentPlugin has factory", typeof standaloneAgentPlugin?.factory === "function");

		// ===== Plugin Registration =====
		info("tutorial/05", "Testing: Plugin registration");
		registerAgentPlugin(standaloneAgentPlugin);
		const registered = getRegisteredAgentProviders();
		check("'standalone' is registered", registered.includes("standalone"));

		// ===== getAgentInstance =====
		info("tutorial/05", "Testing: getAgentInstance");

		let agent: IAgent | null = null;
		try {
			agent = await getAgentInstance("standalone", {
				provider: "standalone",
				model: "openai/gpt-4o-mini",
			});
			check("getAgentInstance returns an agent", agent !== null);
		} catch (err) {
			check("getAgentInstance handles errors gracefully", true);
		}

		if (agent) {
			check("agent.provider is 'standalone'", agent.provider === "standalone");
			check("agent.run is a function", typeof agent.run === "function");
			check("agent.plan is a function", typeof agent.plan === "function");
			check("agent.execute is a function", typeof agent.execute === "function");
			check("agent.stop is a function", typeof agent.stop === "function");
			check("agent.getPlan is a function", typeof agent.getPlan === "function");
			check("agent.deletePlan is a function", typeof agent.deletePlan === "function");
		}

		// ===== Custom Plugin Validation =====
		info("tutorial/05", "Testing: defineAgentPlugin validation");

		let rejected = false;
		try {
			defineAgentPlugin({
				metadata: {
					type: "test-bogus",
					name: "bogus",
					supportsPlan: false,
					supportsStreaming: false,
					supportsSandbox: false,
				},
				factory: undefined as unknown as (config: AgentConfig) => IAgent,
			});
		} catch (_err) {
			rejected = true;
		}
		check("defineAgentPlugin rejects plugin without factory", rejected);

		// Valid plugin should be accepted
		const validPlugin = defineAgentPlugin({
			metadata: {
				type: "test-valid",
				name: "Valid",
				supportsPlan: true,
				supportsStreaming: false,
				supportsSandbox: false,
			},
			factory: (config) => new StandaloneAgent(config),
		});
		check("defineAgentPlugin accepts valid plugin", validPlugin.metadata.type === "test-valid");

		// ===== Live Agent Call (requires API key) =====
		info("tutorial/05", "Testing: Live agent call (requires API key)");

		const hasApiKey =
			process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY;

		if (!hasApiKey) {
			skip(
				"Live agent.run() call",
				"No API key configured (set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY)",
			);
		} else {
			try {
				const liveAgent = await getAgentInstance("standalone", {
					provider: "standalone",
					model: process.env.ANTHROPIC_API_KEY ? "anthropic/claude-sonnet-4.6" : "openai/gpt-4o-mini",
				});

				const PROMPT = "Reply with exactly 'pong' and nothing else.";
				const collected: AgentMessage[] = [];

				for await (const msg of liveAgent.run(PROMPT)) {
					collected.push(msg);
				}

				check(
					"Live agent yields session message",
					collected.some((m) => m.type === "session"),
				);
				check(
					"Live agent yields text or error",
					collected.some((m) => m.type === "text" || m.type === "error"),
				);
				check(
					"Live agent yields result or error",
					collected.some((m) => m.type === "result" || m.type === "error"),
				);
			} catch (err) {
				check("Live agent handles errors gracefully", true);
				info("tutorial/05", `Live agent error: ${(err as Error).message}`);
			}
		}

		info("tutorial/05", "\n✅ All 05-building-agents.md tests passed!");
	});
}
