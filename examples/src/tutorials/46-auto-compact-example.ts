/**
 * E2E demo: `BaseAgent.run` — transparent context-overflow recovery.
 *
 * `BaseAgent.run` wraps the provider-specific `runCore` with an
 * overflow-recovery loop when `providerConfig.compactor` is configured.
 * On a `kind: "context_overflow"` error, the wrapper calls
 * `agent.compactContext({ messages: history })` and re-issues `runCore`
 * with the summary prefixed. A synthetic `scheduleNotice` is yielded
 * between the first stream and the retry stream so the caller can surface
 * a "compacted N → M tokens" toast.
 *
 * For tests / advanced callers that want to drive the same loop from an
 * external `IAgent` stub, `runWithAutoCompact` is still exported and
 * behaves identically.
 *
 * This tutorial demonstrates three scenarios end-to-end:
 *   - Section 1: a normal prompt (no overflow → run is a pass-through).
 *   - Section 2: an artificially large conversation that *would* overflow
 *     if forwarded verbatim. We simulate the overflow by stubbing the
 *     underlying IAgent so the wrapper kicks in.
 *   - Section 3: a real LLM call with a real conversation — proves the
 *     transparent path does NOT regress the happy path. Just call
 *     `agent.run(prompt, { history })`; no separate wrapper required.
 *
 * Set these environment variables before running:
 *
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY
 *   (or OPENCONTEXT_LLM_API_KEY + _BASE_URL + _MODEL for a custom endpoint)
 *
 * Run:
 *   cd examples
 *   node --env-file=../.env --experimental-strip-types \
 *        src/tutorials/46-auto-compact-example.ts
 */

import process from "node:process";

import {
	type AgentHistoryMessage,
	type AgentMessage,
	type AgentOptions,
	type CompactContextResult,
	type IAgent,
	getAgentRegistry,
	registerAgentPlugin,
	standaloneAgentPlugin,
} from "@melandlabs/ai";

import { info, runIfMain } from "../_helpers.ts";

/**
 * `createCompactor` is not part of the published `@melandlabs/opencontext`
 * and `runWithAutoCompact` is not on the published `@melandlabs/ai` until
 * this PR is merged and a new version is released. We resolve both
 * dynamically inside `main()` so the demo gracefully skips against a
 * pre-release smoke-test install. See commit 62ab2d63 for the OKF
 * precedent that established this pattern.
 */
type CreateCompactorFn = typeof import("@melandlabs/opencontext").createCompactor;
type RunWithAutoCompactFn = typeof import("@melandlabs/ai").runWithAutoCompact;
async function resolveCreateCompactor(): Promise<CreateCompactorFn | undefined> {
	const namespace = (await import("@melandlabs/opencontext")) as Record<string, unknown>;
	return typeof namespace.createCompactor === "function"
		? (namespace.createCompactor as CreateCompactorFn)
		: undefined;
}
async function resolveRunWithAutoCompact(): Promise<RunWithAutoCompactFn | undefined> {
	const namespace = (await import("@melandlabs/ai")) as Record<string, unknown>;
	return typeof namespace.runWithAutoCompact === "function"
		? (namespace.runWithAutoCompact as RunWithAutoCompactFn)
		: undefined;
}

/**
 * Pick the cheapest env-driven LLM endpoint that's actually configured.
 * Mirrors the helper in `examples/src/simple/17-ai-agent.ts`. Used to
 * decide whether the live happy-path (Section 3) has anything to talk to.
 *
 * Returns both the source env var (for the model's identity) and the
 * OPENCONTEXT_LLM_* triple (for `createCompactor({})` + `StandaloneAgent`
 * to share the same wire format). Callers that want to run a live call
 * must already have the source env var set in their shell.
 */
function pickAvailableLlmEnv(): { envVar: string; model: string } | undefined {
	const override = process.env.STANDALONE_DEMO_MODEL;
	if (process.env.OPENCONTEXT_LLM_API_KEY) {
		return {
			envVar: "OPENCONTEXT_LLM_API_KEY",
			model: process.env.OPENCONTEXT_LLM_MODEL ?? "openai/gpt-4o-mini",
		};
	}
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

/**
 * Hand-rolled IAgent stub that simulates a context-overflow on the first
 * `run(...)` and a successful reply on the second. Mirrors the helper in
 * `packages/ai/src/agent/auto-compact.test.ts`.
 */
class OverflowSimAgent implements Pick<IAgent, "run" | "compactContext"> {
	runCalls = 0;
	compactCalls: unknown[] = [];

	async *run(_prompt: string, _options?: AgentOptions): AsyncGenerator<AgentMessage> {
		this.runCalls += 1;
		const sessionId = `sim-${this.runCalls}`;

		if (this.runCalls === 1) {
			// Simulate overflow on the first attempt.
			yield { type: "session", sessionId };
			yield {
				type: "error",
				sessionId,
				message: "context_length_exceeded: prompt is too large for the model",
				kind: { kind: "context_overflow", message: "context_length_exceeded" },
			};
			return;
		}

		// Retry succeeds.
		yield { type: "session", sessionId };
		yield { type: "text", sessionId, content: "Got it — the prior context was compacted." };
		yield { type: "result", sessionId, content: "done", duration: 80 };
	}

	async compactContext(input: unknown): Promise<CompactContextResult> {
		this.compactCalls.push(input);
		return {
			summary: "[COMPACTED: HARD -- 6 messages summarized]\n## Summary\n...",
			messageCount: 6,
			level: "hard",
			originalTokens: 480,
			summaryTokens: 92,
		};
	}
}

/**
 * Pass-through stub: emits a single normal text+result stream with no
 * overflow error. Used to prove the wrapper is a no-op when the underlying
 * agent's first attempt succeeds.
 */
class PassThroughAgent implements Pick<IAgent, "run" | "compactContext"> {
	runCalls = 0;
	compactCalls = 0;

	async *run(_prompt: string, _options?: AgentOptions): AsyncGenerator<AgentMessage> {
		this.runCalls += 1;
		const sessionId = `passthrough-${this.runCalls}`;
		yield { type: "session", sessionId };
		yield { type: "text", sessionId, content: "hello to you too" };
		yield { type: "result", sessionId, content: "hello to you too", duration: 20 };
	}

	async compactContext(): Promise<CompactContextResult> {
		this.compactCalls += 1;
		throw new Error("PassThroughAgent.compactContext should never be called");
	}
}

async function main() {
	console.log("\n── runWithAutoCompact e2e ────────────────────────────────────\n");

	// Resolve `runWithAutoCompact` dynamically — see top-of-file note.
	// Sections 1 + 2 drive the wrapper directly; if it's missing from the
	// published `@melandlabs/ai`, skip them.
	const runWithAutoCompact = await resolveRunWithAutoCompact();
	if (!runWithAutoCompact) {
		console.log(
			"[SKIP] @melandlabs/ai is published without runWithAutoCompact yet — sections 1 + 2 + 3 cannot run",
		);
		return;
	}

	// Resolve `createCompactor` dynamically — see top-of-file note. Sections
	// 1 + 2 don't need it (they drive stubs); section 3 onwards does.
	const createCompactor = await resolveCreateCompactor();
	if (!createCompactor) {
		console.log(
			"[SKIP] @melandlabs/opencontext is published without createCompactor yet — sections 1 + 2 still pass against the stubs",
		);
		// Fall through: sections 1 + 2 don't call createCompactor. Section 3
		// and beyond will gate themselves on whether the live LLM env is set
		// AND on whether createCompactor is present, so this run is safe.
	}

	// ─── 1. Pass-through (no overflow) ─────────────────────────────────
	console.log("── 1. pass-through (no overflow) ──");

	const passthroughAgent = new PassThroughAgent();
	const passthroughMessages: AgentMessage[] = [];
	for await (const msg of runWithAutoCompact(passthroughAgent as unknown as IAgent, {
		prompt: "hello",
	})) {
		passthroughMessages.push(msg);
	}
	console.assert(passthroughMessages.length === 3, "no overflow → exactly session+text+result");
	console.assert(
		passthroughMessages.map((m) => m.type).join(",") === "session,text,result",
		"no overflow → messages forwarded unchanged",
	);
	console.assert(passthroughAgent.compactCalls === 0, "no overflow → compactContext never called");
	info(
		"auto-compact",
		`no-overflow pass-through: ${passthroughMessages.length} message(s), last.type=${passthroughMessages.at(-1)?.type}`,
	);

	// ─── 2. Overflow + auto-recover ────────────────────────────────────
	console.log("\n── 2. overflow → compact → retry (simulated) ──");

	const overflowAgent = new OverflowSimAgent();
	const overflowHistory = [
		{ role: "user" as const, content: "earlier 1" },
		{ role: "assistant" as const, content: "earlier 2" },
		{ role: "user" as const, content: "earlier 3" },
		{ role: "assistant" as const, content: "earlier 4" },
		{ role: "user" as const, content: "earlier 5" },
		{ role: "assistant" as const, content: "earlier 6" },
	];
	const onCompacted = (result: CompactContextResult, attempt: number): void => {
		info("auto-compact", `compaction #${attempt}: ${result.messageCount} → ${result.summaryTokens} tokens`);
	};

	const recoveredMessages: AgentMessage[] = [];
	for await (const msg of runWithAutoCompact(overflowAgent as unknown as IAgent, {
		prompt: "summarize what we discussed",
		history: overflowHistory,
		level: "hard",
		onCompacted,
	})) {
		recoveredMessages.push(msg);
	}

	console.assert(overflowAgent.runCalls === 2, "wrapper must have retried exactly once");
	console.assert(overflowAgent.compactCalls.length === 1, "wrapper must compact exactly once");
	console.assert(
		recoveredMessages.map((m) => m.type).join(",") === "session,scheduleNotice,session,text,result",
		"interleaved message shape must be: first session, notice, retry stream",
	);
	const notice = recoveredMessages[1];
	console.assert(notice.type === "scheduleNotice", "second message must be the synthetic notice");
	info("auto-compact", `recovered stream: ${recoveredMessages.map((m) => m.type).join(",")}`);

	// ─── 3. Real LLM-backed happy path ─────────────────────────────────
	console.log("\n── 3. real LLM-backed happy path ──");

	const live = pickAvailableLlmEnv();
	if (!live) {
		console.log(
			"Skipping live auto-compact demo: set ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY",
		);
		console.log("(or OPENCONTEXT_LLM_API_KEY + _BASE_URL + _MODEL) and re-run.");
		return;
	}
	if (!createCompactor) {
		console.log(
			"Skipping live auto-compact demo: createCompactor is not in the published @melandlabs/opencontext yet",
		);
		return;
	}

	// Mirror whichever key we found into the OPENCONTEXT_LLM_* form the
	// compactor factory reads, so `createCompactor({})` (no explicit args)
	// can resolve the same endpoint without the caller having to re-pass
	// apiKey/baseUrl/model. ANTHROPIC_BASE_URL is honoured as the baseUrl
	// when the source key is ANTHROPIC_API_KEY so the live call still
	// reaches an Anthropic-compatible gateway.
	if (!process.env.OPENCONTEXT_LLM_API_KEY) {
		process.env.OPENCONTEXT_LLM_API_KEY = process.env[live.envVar];
		process.env.OPENCONTEXT_LLM_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "";
		process.env.OPENCONTEXT_LLM_MODEL = live.model;
	}
	registerAgentPlugin(standaloneAgentPlugin);
	const compactor = createCompactor({});

	// StandaloneAgent reads LLM settings from the AI user context. Wire the
	// resolved key into both `anthropicCompatible` (when the source key is
	// an Anthropic-style token, OR when the baseUrl looks anthropic-shaped)
	// and `openaiCompatible` (everything else) so the live call reaches
	// the configured endpoint.
	const { setAIUserContext } = await import("@melandlabs/ai");
	const baseUrlHint =
		process.env.ANTHROPIC_BASE_URL ??
		process.env.OPENCONTEXT_LLM_BASE_URL ??
		process.env.OPENAI_BASE_URL ??
		"";
	const anthropicLike = live.envVar === "ANTHROPIC_API_KEY" || /anthropic/i.test(baseUrlHint);
	setAIUserContext({
		id: "tutorial-46-demo",
		email: null,
		name: null,
		type: "tutorial",
		token: process.env[live.envVar],
		llmApiSettings: anthropicLike
			? {
					anthropicCompatible: {
						apiKey: process.env[live.envVar] ?? "",
						baseUrl:
							process.env.ANTHROPIC_BASE_URL ??
							process.env.OPENCONTEXT_LLM_BASE_URL ??
							"https://api.anthropic.com/v1",
						model: live.model,
					},
				}
			: {
					openaiCompatible: {
						apiKey: process.env[live.envVar] ?? "",
						baseUrl: process.env.OPENAI_BASE_URL ?? process.env.OPENCONTEXT_LLM_BASE_URL ?? "",
						model: live.model,
					},
				},
	});

	const liveAgent: IAgent = getAgentRegistry().create({
		provider: "standalone",
		model: live.model,
		providerConfig: { compactor },
	});

	// Transparent auto-compact: just call agent.run(prompt, { history }).
	// No runWithAutoCompact wrapper, no setAIUserContext dance — when
	// `providerConfig.compactor` is set, `BaseAgent.run` handles overflow
	// recovery internally.
	const collected: AgentMessage[] = [];
	for await (const msg of liveAgent.run("Reply with the single word 'pong' and nothing else.", {
		history: [
			{ role: "user" as const, content: "earlier turn 1" },
			{ role: "assistant" as const, content: "earlier turn 2" },
		],
	})) {
		collected.push(msg);
	}

	const result = collected.find((m) => m.type === "result");
	const error = collected.find((m) => m.type === "error");
	console.assert(error === undefined, "happy path must not surface an error");
	console.assert(result !== undefined, "happy path must yield a result message");
	console.assert(
		result?.content?.toLowerCase().includes("pong"),
		"underlying model must still receive the prompt",
	);
	info(
		"auto-compact",
		`live happy path (via ${live.envVar}): ${collected.length} message(s), result=${JSON.stringify(result?.content?.slice(0, 60))}`,
	);

	// ─── 4. User-facing: "configure once, just keep running" ───────────
	// The minimum code a host writes to enable auto-compact:
	//
	//   1. Build a compactor.
	//   2. Attach it via providerConfig.compactor.
	//   3. Just call agent.run() in your loop.
	//
	// That's it. Every call gets transparent overflow recovery for free.
	console.log("\n── 4. user-facing: 'configure once, just keep running' ──");

	const hostCompactor = createCompactor({});
	const hostAgent: IAgent = getAgentRegistry().create({
		provider: "standalone",
		model: live.model,
		providerConfig: { compactor: hostCompactor },
	});

	// Just run() in a loop — auto-compact stays invisible in the background.
	const hostHistory: AgentHistoryMessage[] = [
		{ role: "user", content: "I'm starting a vet-tracking app for my cat Luna." },
		{ role: "assistant", content: "Sounds good. What's the project name?" },
	];
	const hostPrompts = [
		"Let's call it LunaVet. What's a good stack?",
		"Anything else to remember before we start coding?",
	];
	for (const prompt of hostPrompts) {
		const collected4: AgentMessage[] = [];
		for await (const msg of hostAgent.run(prompt, { history: hostHistory })) {
			collected4.push(msg);
		}
		const result4 = collected4.find((m) => m.type === "result");
		info("user-demo", `Q: ${prompt.slice(0, 50)} → A: ${JSON.stringify(result4?.content?.slice(0, 80))}`);
	}
	info(
		"user-demo",
		`ran ${hostPrompts.length} turns — auto-compact is configured but invisible to the host loop`,
	);

	console.log("\n✓ BaseAgent.run auto-compact e2e completed");
}

export default main;
runIfMain("auto-compact", main, import.meta.url);
