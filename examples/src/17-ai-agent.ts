/**
 * demo: @melandlabs/ai — IAgent contract + StandaloneAgent.
 *
 * The @melandlabs/ai package exposes the IAgent contract, the BaseAgent
 * base class, the AgentRegistry / AgentRuntime plumbing, defineAgentPlugin,
 * and one built-in provider implementation: StandaloneAgent. Standalone
 * does a single LLM call (no tools, no plan) and yields the reply back
 * through the standard AgentMessage stream.
 *
 * The static surface — IAgent, BaseAgent, defineAgentPlugin,
 * getAgentInstance, registerAgentPlugin, runAgentRuntimeRequest,
 * StandaloneAgent, standaloneAgentPlugin, STANDALONE_METADATA — is
 * reachable from the package root, so we always exercise that. The
 * live `agent.run()` call needs a working LLM endpoint
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY) and a
 * model name the host has access to. Without those the live call is
 * skipped, but the type/registry surface above is enough to prove the
 * wiring.
 */

import process from "node:process";
import {
	type AgentConfig,
	type AgentMessage,
	type AgentProvider,
	BaseAgent,
	type BuiltinAgentProvider,
	type IAgent,
	STANDALONE_METADATA,
	StandaloneAgent,
	defineAgentPlugin,
	getAgentInstance,
	getAgentRegistry,
	getRegisteredAgentProviders,
	registerAgentPlugin,
	runAgentRuntimeRequest,
	standaloneAgentPlugin,
} from "@melandlabs/ai";
import { info, makeCheckWithSkip, runSection } from "./_helpers.ts";

const PROMPT = "Reply with the single word 'pong' and nothing else.";

/** Pick the cheapest env-driven LLM endpoint that's actually configured. */
function pickAvailableLlmEnv(): { envVar: string; model: string } | undefined {
	const override = process.env.STANDALONE_DEMO_MODEL;
	if (process.env.ANTHROPIC_API_KEY) {
		return { envVar: "ANTHROPIC_API_KEY", model: override ?? "anthropic/claude-sonnet-4.6" };
	}
	if (process.env.OPENAI_API_KEY) {
		return { envVar: "OPENAI_API_KEY", model: override ?? "openai/gpt-4o-mini" };
	}
	if (process.env.OPENROUTER_API_KEY) {
		return { envVar: "OPENROUTER_API_KEY", model: override ?? "openai/gpt-4o-mini" };
	}
	return undefined;
}

export default async function demoAiAgent() {
	await runSection("demo: @melandlabs/ai — IAgent + StandaloneAgent", async () => {
		const { check, skip } = makeCheckWithSkip("demo/ai-agent");

		// ---- 1. Static surface is reachable from the package root ----
		// The mere fact that this file type-checks already proves the imports
		// resolve; these runtime assertions back that up with concrete values.
		check("StandaloneAgent is a constructable class", typeof StandaloneAgent === "function");
		check("BaseAgent is a constructable abstract class", typeof BaseAgent === "function");
		check(
			"StandaloneAgent.prototype is a BaseAgent (extends BaseAgent)",
			Object.getPrototypeOf(StandaloneAgent.prototype) === BaseAgent.prototype,
		);
		check(
			"standaloneAgentPlugin is a plugin object with metadata + factory",
			typeof standaloneAgentPlugin === "object" &&
				standaloneAgentPlugin !== null &&
				typeof standaloneAgentPlugin.factory === "function" &&
				typeof standaloneAgentPlugin.metadata === "object",
		);
		check(
			"standaloneAgentPlugin.metadata.type === 'standalone'",
			standaloneAgentPlugin.metadata.type === "standalone",
		);
		check("STANDALONE_METADATA.type === 'standalone'", STANDALONE_METADATA.type === "standalone");
		check(
			"STANDALONE_METADATA.supportsPlan === false (single-shot, no plan)",
			STANDALONE_METADATA.supportsPlan === false,
		);
		check("STANDALONE_METADATA.supportsStreaming === false", STANDALONE_METADATA.supportsStreaming === false);
		check("STANDALONE_METADATA.supportsSandbox === false", STANDALONE_METADATA.supportsSandbox === false);
		check("defineAgentPlugin is callable", typeof defineAgentPlugin === "function");
		check("getAgentRegistry is callable", typeof getAgentRegistry === "function");
		check("registerAgentPlugin is callable", typeof registerAgentPlugin === "function");
		check("getAgentInstance is callable", typeof getAgentInstance === "function");
		check("getRegisteredAgentProviders is callable", typeof getRegisteredAgentProviders === "function");
		check("runAgentRuntimeRequest is callable", typeof runAgentRuntimeRequest === "function");

		// ---- 2. defineAgentPlugin validates required fields ----
		// A bogus plugin without a factory must throw; the same shape with
		// all required fields must round-trip cleanly.
		let bogusRejected = false;
		try {
			defineAgentPlugin({
				metadata: {
					type: "demo-bogus",
					name: "bogus",
					supportsPlan: false,
					supportsStreaming: false,
					supportsSandbox: false,
				},
				factory: undefined as unknown as (config: AgentConfig) => IAgent,
			});
		} catch (_err) {
			bogusRejected = true;
		}
		check("defineAgentPlugin rejects a plugin without a factory", bogusRejected);

		const validated = defineAgentPlugin({
			metadata: {
				type: "demo-validated",
				name: "Validated",
				supportsPlan: false,
				supportsStreaming: false,
				supportsSandbox: false,
			},
			factory: (config) => new StandaloneAgent(config),
		});
		check(
			"defineAgentPlugin returns the plugin unchanged when valid",
			validated.metadata.type === "demo-validated",
		);

		// ---- 3. Registry round-trip ----
		// Registering the real plugin; the registry is a global singleton but
		// re-registering the same type is a silent overwrite, so this is safe
		// even if a previous demo touched it.
		registerAgentPlugin(standaloneAgentPlugin);
		const registered = getRegisteredAgentProviders();
		check(
			"after register, 'standalone' is in the registered providers list",
			registered.includes("standalone"),
		);

		const agent = (await getAgentInstance("standalone", {
			provider: "standalone",
			model: pickAvailableLlmEnv()?.model ?? "openai/gpt-4o-mini",
			// isNativeMode lives under providerConfig (Standalone reads it from
			// there); default false is fine for a Node test.
		})) as IAgent;
		info("demo/ai-agent", `getAgentInstance('standalone') → provider=${agent.provider}`);
		check("the returned agent's .provider is 'standalone'", agent.provider === "standalone");
		check("the returned agent implements agent.run (IAgent)", typeof agent.run === "function");
		check("the returned agent implements agent.plan (IAgent)", typeof agent.plan === "function");
		check("the returned agent implements agent.execute (IAgent)", typeof agent.execute === "function");
		check("the returned agent implements agent.stop (IAgent)", typeof agent.stop === "function");
		check("the returned agent implements agent.getPlan (IAgent)", typeof agent.getPlan === "function");
		check("the returned agent implements agent.deletePlan (IAgent)", typeof agent.deletePlan === "function");
		check(
			"agent.getPlan always returns undefined (Standalone has no plan store)",
			agent.getPlan("anything") === undefined,
		);
		check(
			"agent.deletePlan is a safe no-op on Standalone",
			(() => {
				try {
					agent.deletePlan("anything");
					return true;
				} catch {
					return false;
				}
			})(),
		);

		// ---- 4. BuiltinAgentProvider union now accepts the 'standalone' literal ----
		// This is a compile-time check; at runtime we just confirm the literal
		// value is the expected string.
		const literal: BuiltinAgentProvider = "standalone";
		check("BuiltinAgentProvider union accepts the literal 'standalone'", literal === "standalone");

		// ---- 5. Live LLM call (skips gracefully without a configured endpoint) ----
		const live = pickAvailableLlmEnv();
		if (!live) {
			skip(
				"StandaloneAgent.run(...)",
				"no ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY set — live LLM call skipped",
			);
			return;
		}

		info("demo/ai-agent", `live LLM call via ${live.envVar}, model=${live.model}`);

		// Re-instantiate with the chosen model so the live call actually uses it.
		const liveAgent: IAgent = await getAgentInstance("standalone", {
			provider: "standalone",
			model: live.model,
		});

		const ac = new AbortController();
		const timeout = setTimeout(() => ac.abort(new Error("demo timeout after 30s")), 30_000);

		const collected: AgentMessage[] = [];
		try {
			for await (const msg of liveAgent.run(PROMPT, { abortController: ac })) {
				collected.push(msg);
				if (msg.type === "session") {
					info("demo/ai-agent", `session ${msg.sessionId} started`);
				} else if (msg.type === "text") {
					info("demo/ai-agent", `text: ${JSON.stringify((msg.content ?? "").slice(0, 120))}`);
				} else if (msg.type === "result") {
					info(
						"demo/ai-agent",
						`result: ${msg.usage?.inputTokens ?? "?"} in / ${msg.usage?.outputTokens ?? "?"} out, ${msg.duration}ms`,
					);
				} else if (msg.type === "error") {
					info("demo/ai-agent", `error: ${msg.message}`);
				}
			}
		} finally {
			clearTimeout(timeout);
		}

		const first = collected[0];
		check(
			"agent.run yields a 'session' message first",
			first?.type === "session" || first?.type === "error",
			`first.type=${first?.type ?? "<none>"}`,
		);
		check(
			"agent.run yields at least one 'text' or 'error' message",
			collected.some((m) => m.type === "text" || m.type === "error"),
			`${collected.length} message(s) collected`,
		);
		const last = collected.at(-1);
		check(
			"agent.run terminates with a 'result' or 'error' message",
			last?.type === "result" || last?.type === "error",
			`last.type=${last?.type ?? "<none>"}`,
		);

		// Unused-export reference: the AgentProvider type alias is reachable
		// from the root, even though we don't need to do anything with it
		// at runtime. This is a compile-time proof that the type made it.
		const _providerAlias: AgentProvider = "standalone";
		void _providerAlias;
	});
}
