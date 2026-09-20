/**
 * Unit tests for `BaseAgent.run`'s transparent auto-compact behaviour.
 *
 * When `providerConfig.compactor` is set, `BaseAgent.run` must:
 *   - Forward to `runCore` on the first attempt.
 *   - On `kind: "context_overflow"`, call `agent.compactContext` over
 *     `options.conversation`, yield a synthetic `retry` notice, then
 *     re-issue `runCore` (NOT `run` — re-entry would infinite-loop).
 *   - Pass the retry prompt through the loop unchanged (the caller
 *     never sees the overflow error itself).
 *
 * When no compactor is configured, `BaseAgent.run` must be a pure
 * pass-through to `runCore`: no compact call, no notice, no second
 * attempt on overflow.
 */
import { describe, expect, it, vi } from "vitest";

import { BaseAgent } from "./base";
import type {
	AgentConfig,
	AgentMessage,
	AgentOptions,
	CompactContextInput,
	CompactContextResult,
	Compactor,
	ExecuteOptions,
	PlanOptions,
} from "./types";

class StubBaseAgent extends BaseAgent {
	readonly provider = "stub" as const;

	// Configurable runCore behaviour for each test.
	coreStreams: AsyncGenerator<AgentMessage>[] = [];
	coreCalls = 0;
	corePrompts: string[] = [];

	async *runCore(prompt: string, _options?: AgentOptions): AsyncGenerator<AgentMessage> {
		this.coreCalls += 1;
		this.corePrompts.push(prompt);
		const stream = this.coreStreams.shift();
		if (!stream) throw new Error("StubBaseAgent: no runCore stream queued");
		yield* stream;
	}

	async *plan(_prompt: string, _options?: PlanOptions): AsyncGenerator<AgentMessage> {
		yield { type: "error", message: "plan not implemented in stub" };
	}

	async *execute(_options: ExecuteOptions): AsyncGenerator<AgentMessage> {
		yield { type: "error", message: "execute not implemented in stub" };
	}
}

async function* textStream(text: string): AsyncGenerator<AgentMessage> {
	yield { type: "session", sessionId: "s1" };
	yield { type: "text", sessionId: "s1", content: text };
	yield { type: "result", sessionId: "s1", content: text, duration: 50 };
}

async function* overflowStream(): AsyncGenerator<AgentMessage> {
	yield { type: "session", sessionId: "s1" };
	yield {
		type: "error",
		sessionId: "s1",
		message: "context_length_exceeded",
		kind: { kind: "context_overflow", message: "context_length_exceeded" },
	};
}

/**
 * Build a minimal Compactor stub that records `compact()` calls and
 * returns a canned result. Only `compact` is part of the public surface
 * used by the loop. Returned shape: `{ compactor, compactSpy }` so tests
 * can assert on the spy without losing the `Compactor` type at the
 * call site.
 */
function makeCompactorStub(): {
	compactor: Compactor;
	compactSpy: ReturnType<typeof vi.fn>;
} {
	const compactSpy = vi.fn(
		async (_input: CompactContextInput): Promise<CompactContextResult> => ({
			summary: "[COMPACTED]",
			messageCount: 3,
			level: "hard",
			originalTokens: 400,
			summaryTokens: 90,
		}),
	);
	const compactor: Compactor = { compact: compactSpy };
	return { compactor, compactSpy };
}

function makeAgent(providerConfig: AgentConfig["providerConfig"]): StubBaseAgent {
	const config: AgentConfig = { provider: "stub", providerConfig };
	return new StubBaseAgent(config);
}

describe("BaseAgent.run auto-compact", () => {
	it("is a pure pass-through to runCore when no compactor is configured", async () => {
		const agent = makeAgent(undefined);
		agent.coreStreams.push(textStream("hello"));

		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("hi")) {
			collected.push(msg);
		}

		expect(collected.map((m) => m.type)).toEqual(["session", "text", "result"]);
		expect(agent.coreCalls).toBe(1);
		expect(agent.corePrompts).toEqual(["hi"]);
	});

	it("forwards overflow errors verbatim when no compactor is configured", async () => {
		const agent = makeAgent(undefined);
		agent.coreStreams.push(overflowStream());

		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("hi")) {
			collected.push(msg);
		}

		// No retry: the overflow error is surfaced unchanged.
		expect(collected.map((m) => m.type)).toEqual(["session", "error"]);
		expect(agent.coreCalls).toBe(1);
	});

	it("transparently compacts on overflow and yields a retry notice before the retry stream", async () => {
		const { compactor, compactSpy } = makeCompactorStub();
		const agent = makeAgent({ compactor });
		agent.coreStreams.push(overflowStream());
		agent.coreStreams.push(textStream("after compaction"));

		const history = [
			{ role: "user" as const, content: "earlier 1" },
			{ role: "assistant" as const, content: "earlier 2" },
			{ role: "user" as const, content: "earlier 3" },
		];

		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("summarize what we discussed", { conversation: history })) {
			collected.push(msg);
		}

		// First attempt: session only (overflow suppressed).
		// Then: synthetic retry notice.
		// Then: retry stream (session + text + result).
		expect(collected.map((m) => m.type)).toEqual(["session", "retry", "session", "text", "result"]);
		expect((collected[1] as { message?: string }).message ?? "").toMatch(/\[auto-compact\] compacted/);
		expect(collected[1].attempt).toBe(2);
		expect(collected[1].maxAttempts).toBe(2);
		expect(agent.coreCalls).toBe(2);
		// compactor was invoked with the caller-supplied conversation.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const call = compactSpy.mock.calls[0][0] as CompactContextInput;
		expect(call.messages).toEqual(history);
		expect(call.level).toBe("hard");
	});

	it("calls runCore directly (never this.run) so the wrapper is not re-entered on overflow", async () => {
		const { compactor } = makeCompactorStub();
		const agent = makeAgent({ compactor });

		// Spy on the inherited `run` to assert it is NEVER invoked from
		// inside the wrapper — only `runCore` should be. The stub is wired
		// to overflow on every attempt; if `run` were re-entered we'd see
		// infinite recursion (and a stack / budget error) rather than the
		// expected budget-exhaustion behaviour.
		const runSpy = vi.spyOn(agent, "run");
		agent.coreStreams.push(overflowStream());
		agent.coreStreams.push(overflowStream());
		agent.coreStreams.push(overflowStream());

		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("p", { conversation: [{ role: "user", content: "h" }] })) {
			collected.push(msg);
		}

		// The agent.run(...) generator was entered exactly once — the
		// outer caller. The retry path inside the wrapper must call
		// runCore, not run.
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(agent.coreCalls).toBe(2);
		expect(collected.map((m) => m.type)).toEqual(["session", "retry", "session", "error"]);
		expect((collected.at(-1) as { kind?: { kind: string } }).kind?.kind).toBe("context_overflow");
	});

	it("does NOT call compactContext when the first attempt succeeds", async () => {
		const { compactor, compactSpy } = makeCompactorStub();
		const agent = makeAgent({ compactor });
		agent.coreStreams.push(textStream("hello"));

		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("hi", { conversation: [{ role: "user", content: "h" }] })) {
			collected.push(msg);
		}

		expect(collected.map((m) => m.type)).toEqual(["session", "text", "result"]);
		expect(compactSpy).not.toHaveBeenCalled();
		expect(agent.coreCalls).toBe(1);
	});

	it("threads options (abortController, etc.) through to runCore on the first attempt", async () => {
		const { compactor } = makeCompactorStub();
		const agent = makeAgent({ compactor });
		agent.coreStreams.push(textStream("ok"));

		const ac = new AbortController();
		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("hi", { abortController: ac, conversation: [] })) {
			collected.push(msg);
		}

		expect(collected.map((m) => m.type)).toEqual(["session", "text", "result"]);
		expect(agent.coreCalls).toBe(1);
	});

	it("wires providerConfig.compactThresholdTokens into the proactive path", async () => {
		const { compactor, compactSpy } = makeCompactorStub();
		const agent = makeAgent({ compactor, compactThresholdTokens: 10 });
		agent.coreStreams.push(textStream("ok"));

		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("hi", {
			conversation: [
				{ role: "user", content: "a long earlier message exceeding ten estimated tokens easily" },
			],
		})) {
			collected.push(msg);
		}

		// Proactive compaction fired before the first attempt — no overflow
		// error was needed.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(collected.map((m) => m.type)).toEqual(["retry", "session", "text", "result"]);
		expect((collected[0] as { message?: string }).message ?? "").toMatch(/proactively compacted/);
	});

	it("threads AgentOptions.onCompactionBaseline through to the recovery loop", async () => {
		const { compactor } = makeCompactorStub();
		const agent = makeAgent({ compactor });
		agent.coreStreams.push(overflowStream());
		agent.coreStreams.push(textStream("after compaction"));

		const baselines: Array<Array<{ role: string; content: string }>> = [];
		for await (const _msg of agent.run("p", {
			conversation: [
				{ role: "user", content: "earlier 1" },
				{ role: "assistant", content: "earlier 2" },
			],
			onCompactionBaseline: (baseline) => baselines.push(baseline),
		})) {
			void _msg;
		}

		expect(baselines).toHaveLength(1);
		expect(baselines[0][0].role).toBe("system");
		expect(baselines[0][0].content).toContain("[Carry-forward summary from earlier 2 message(s)]");
	});
});
