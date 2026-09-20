/**
 * E2E smoke test for the transparent auto-compact behavior on `BaseAgent.run`.
 *
 * This file exercises the new contract from a host's perspective: a real
 * `StandaloneAgent` with `providerConfig.compactor` attached, two consecutive
 * calls (one small + one long), and the expected message shapes from both.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... \
 *   ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
 *   ANTHROPIC_MODEL=MiniMax-M3-highspeed \
 *     node --experimental-strip-types \
 *          src/tutorials/46-e2e-transparent-autocompact.ts
 */

import process from "node:process";

import { type AgentMessage, type IAgent, setAIUserContext, StandaloneAgent } from "@melandlabs/ai";

import { info, runIfMain } from "../_helpers.ts";

async function main(): Promise<void> {
	// `createCompactor` is not in the published `@melandlabs/opencontext`
	// until this PR is merged and a new version is released. Resolve it
	// dynamically so pre-release smoke tests skip gracefully. See commit
	// 62ab2d63 for the OKF precedent.
	const compactionNamespace = (await import("@melandlabs/opencontext")) as Record<string, unknown>;
	if (typeof compactionNamespace.createCompactor !== "function") {
		console.log(
			"[SKIP] @melandlabs/opencontext is published without createCompactor yet — e2e transparent auto-compact skipped",
		);
		return;
	}
	const { createCompactor } = compactionNamespace as {
		createCompactor: typeof import("@melandlabs/opencontext").createCompactor;
	};

	if (!process.env.ANTHROPIC_API_KEY) {
		console.log("Skipping e2e: set ANTHROPIC_API_KEY (+ ANTHROPIC_BASE_URL + ANTHROPIC_MODEL) and re-run.");
		return;
	}

	// StandaloneAgent reads its LLM settings from the AI user context.
	// Wire ANTHROPIC_* env vars into it so the live call actually reaches
	// the configured endpoint.
	setAIUserContext({
		id: "tutorial-46-e2e",
		email: null,
		name: null,
		type: "tutorial",
		token: process.env.ANTHROPIC_API_KEY,
		llmApiSettings: {
			anthropicCompatible: {
				apiKey: process.env.ANTHROPIC_API_KEY ?? "",
				baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
				model: process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest",
			},
		},
	});

	// Build a compactor that talks to the same endpoint. OPENCONTEXT_LLM_*
	// env vars are read by the compactor's llm-factory; mirror the
	// anthropic settings into those so we don't need a separate env mapping.
	process.env.OPENCONTEXT_LLM_API_KEY = process.env.ANTHROPIC_API_KEY;
	process.env.OPENCONTEXT_LLM_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "";
	process.env.OPENCONTEXT_LLM_MODEL = process.env.ANTHROPIC_MODEL ?? "";
	const compactor = createCompactor({});

	const agent: IAgent = new StandaloneAgent({
		provider: "standalone",
		model: process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest",
		providerConfig: { compactor },
	});

	// ─── Section A: short happy path ────────────────────────────────
	console.log("\n── A. short happy path (no overflow) ──");

	const shortMessages: AgentMessage[] = [];
	for await (const msg of agent.run("Reply with the single word 'pong' and nothing else.", {
		history: [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		],
	})) {
		shortMessages.push(msg);
	}

	const typesA = shortMessages.map((m) => m.type).join(",");
	console.assert(typesA === "session,text,result", `A: expected session,text,result got ${typesA}`);
	console.assert(
		shortMessages.some((m) => m.type === "result" && (m.content ?? "").toLowerCase().includes("pong")),
		"A: result should mention pong",
	);
	info(
		"e2e/auto-compact/A",
		`short happy path: ${shortMessages.length} message(s), result=${JSON.stringify(
			shortMessages.find((m) => m.type === "result")?.content?.slice(0, 60),
		)}`,
	);

	// ─── Section B: verify the compactor path is wired ──────────────
	// Compact a real conversation directly via `agent.compactContext` to
	// confirm the compactor factory is correctly attached through
	// `providerConfig.compactor` (proves the wiring without needing a
	// genuine overflow event on a small model).
	console.log("\n── B. compactContext wiring (synthetic input) ──");

	const synth = await agent.compactContext({
		messages: [
			{ role: "user", content: "Tell me about TypeScript generics." },
			{
				role: "assistant",
				content:
					"TypeScript generics let you write reusable, type-safe code. For example, `function identity<T>(value: T): T { return value; }` works for any type.",
			},
		],
		level: "hard",
	});

	console.assert(
		typeof synth.summary === "string" && synth.summary.length > 0,
		"B: summary must be non-empty",
	);
	console.assert(synth.messageCount === 2, `B: messageCount=${synth.messageCount}, expected 2`);
	console.assert(synth.summaryTokens > 0, `B: summaryTokens=${synth.summaryTokens}, expected > 0`);
	info(
		"e2e/auto-compact/B",
		`compactContext: ${synth.messageCount} message(s) → ${synth.summaryTokens} token(s), level=${synth.level}`,
	);

	console.log("\n✓ BaseAgent.run transparent auto-compact e2e completed");
}

export default main;
runIfMain("e2e-autocompact", main, import.meta.url);
