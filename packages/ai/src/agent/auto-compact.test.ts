/**
 * Unit tests for `runWithAutoCompact`.
 *
 * Uses a hand-rolled IAgent stub so we can deterministically:
 *   - emit a `kind: "context_overflow"` error on the first attempt
 *   - emit a normal text+result stream on the retry
 *   - assert the wrapper interleaves the synthetic retry notice + retry
 *     messages correctly, and never re-emits the underlying overflow error.
 */
import { describe, expect, it, vi } from "vitest";

import { runWithAutoCompact } from "./auto-compact";
import type { AgentMessage, AgentOptions, CompactContextResult, ConversationMessage, IAgent } from "./types";

class StubAgent implements Pick<IAgent, "run" | "compactContext"> {
	runStreams: Array<AsyncGenerator<AgentMessage>> = [];
	runPrompts: string[] = [];
	compactResults: CompactContextResult[] = [];
	compactSpy = vi.fn(async (_input: unknown): Promise<CompactContextResult> => {
		return (
			this.compactResults.shift() ?? {
				summary: "[COMPACTED: HARD -- 4 messages summarized]\n## Summary\n...",
				messageCount: 4,
				level: "hard",
				originalTokens: 500,
				summaryTokens: 80,
			}
		);
	});

	async *run(prompt: string, _options?: AgentOptions): AsyncGenerator<AgentMessage> {
		this.runPrompts.push(prompt);
		const stream = this.runStreams.shift();
		if (!stream) throw new Error("StubAgent: no run stream queued");
		yield* stream;
	}

	async compactContext(input: unknown): Promise<CompactContextResult> {
		return this.compactSpy(input);
	}
}

async function* textStream(text: string): AsyncGenerator<AgentMessage> {
	yield { type: "session", sessionId: "s1" };
	yield { type: "text", sessionId: "s1", content: text };
	yield { type: "result", sessionId: "s1", content: text, duration: 100 };
}

async function* overflowStream(
	message = "context_length_exceeded: prompt too large",
): AsyncGenerator<AgentMessage> {
	yield { type: "session", sessionId: "s1" };
	yield {
		type: "error",
		sessionId: "s1",
		message,
		kind: { kind: "context_overflow", message },
	};
}

describe("runWithAutoCompact", () => {
	it("passes messages through unchanged when the first attempt succeeds", async () => {
		const stub = new StubAgent();
		stub.runStreams.push(textStream("hello world"));

		const collected: AgentMessage[] = [];
		for await (const msg of runWithAutoCompact(stub as unknown as IAgent, {
			prompt: "hi",
			history: [{ role: "user", content: "earlier" }],
		})) {
			collected.push(msg);
		}

		expect(collected.map((m) => m.type)).toEqual(["session", "text", "result"]);
		expect(collected[1].content).toBe("hello world");
		expect(stub.compactSpy).not.toHaveBeenCalled();
	});

	it("compacts on overflow and yields a retry notice before the retry stream", async () => {
		const stub = new StubAgent();
		stub.runStreams.push(overflowStream());
		stub.runStreams.push(textStream("after compaction"));

		const collected: AgentMessage[] = [];
		for await (const msg of runWithAutoCompact(stub as unknown as IAgent, {
			prompt: "what now?",
			history: [
				{ role: "user", content: "earlier 1" },
				{ role: "assistant", content: "earlier 2" },
				{ role: "user", content: "earlier 3" },
				{ role: "assistant", content: "earlier 4" },
			],
		})) {
			collected.push(msg);
		}

		// First attempt: session only (overflow error suppressed).
		// Then: synthetic retry notice.
		// Then: retry stream (session + text + result).
		expect(collected.map((m) => m.type)).toEqual(["session", "retry", "session", "text", "result"]);
		const notice = collected[1];
		expect(notice.attempt).toBe(2);
		expect(notice.maxAttempts).toBe(2);
		expect(notice.message ?? "").toMatch(/\[auto-compact\] compacted 4 prior message\(s\) → 80 tokens/);
		expect(stub.compactSpy).toHaveBeenCalledTimes(1);
		// The retry prompt folds the compaction summary in front of the original prompt.
		expect(stub.runPrompts[1]).toContain("[carry-forward summary from earlier 4 message(s)]");
		expect(stub.runPrompts[1]).toContain("what now?");
	});

	it("passes the original history + level into compactContext", async () => {
		const stub = new StubAgent();
		stub.runStreams.push(overflowStream());
		stub.runStreams.push(textStream("ok"));

		const history: ConversationMessage[] = [
			{ role: "user", content: "m1" },
			{ role: "assistant", content: "m2" },
		];

		for await (const _msg of runWithAutoCompact(stub as unknown as IAgent, {
			prompt: "p",
			history,
			level: "emergency",
		})) {
			void _msg;
		}

		expect(stub.compactSpy).toHaveBeenCalledTimes(1);
		const call = stub.compactSpy.mock.calls[0][0] as { messages: unknown[]; level: string };
		expect(call.messages).toHaveLength(2);
		expect(call.level).toBe("emergency");
	});

	it("fires the onCompacted callback with the compaction result + attempt number", async () => {
		const stub = new StubAgent();
		stub.runStreams.push(overflowStream());
		stub.runStreams.push(textStream("ok"));

		const onCompacted = vi.fn();
		for await (const _msg of runWithAutoCompact(stub as unknown as IAgent, {
			prompt: "p",
			history: [{ role: "user", content: "m1" }],
			onCompacted,
		})) {
			void _msg;
		}

		expect(onCompacted).toHaveBeenCalledTimes(1);
		const [result, attempt] = onCompacted.mock.calls[0] as [CompactContextResult, number];
		expect(result.summaryTokens).toBe(80);
		expect(attempt).toBe(1);
	});

	it("retries the original prompt unchanged when there is no history (no compaction call)", async () => {
		const stub = new StubAgent();
		stub.runStreams.push(overflowStream());
		stub.runStreams.push(textStream("ok"));

		const collected: AgentMessage[] = [];
		for await (const msg of runWithAutoCompact(stub as unknown as IAgent, {
			prompt: "one-shot oversized prompt",
		})) {
			collected.push(msg);
		}

		// Empty history must NOT reach the compactor (it would throw on an
		// empty message list) — the wrapper retries the original prompt as-is.
		expect(stub.compactSpy).not.toHaveBeenCalled();
		expect(stub.runPrompts).toEqual(["one-shot oversized prompt", "one-shot oversized prompt"]);
		expect(collected.map((m) => m.type)).toEqual(["session", "retry", "session", "text", "result"]);
		expect(collected[1].message ?? "").toMatch(/no prior history to compact/);
	});

	it("falls back to deterministic truncation when compaction fails, then retries", async () => {
		const stub = new StubAgent();
		stub.runStreams.push(overflowStream("context_length_exceeded: prompt too large"));
		stub.runStreams.push(textStream("ok"));
		stub.compactSpy.mockRejectedValueOnce(new Error("compactor LLM unreachable"));

		const collected: AgentMessage[] = [];
		for await (const msg of runWithAutoCompact(stub as unknown as IAgent, {
			prompt: "p",
			history: [
				{ role: "user", content: "m1" },
				{ role: "assistant", content: "m2" },
			],
		})) {
			collected.push(msg);
		}

		// Cline-style rule: recovery must not depend on another successful
		// LLM request — the wrapper drops the oldest half once and retries
		// with a truncation notice instead of surfacing the overflow.
		expect(stub.compactSpy).toHaveBeenCalledTimes(1);
		expect(collected.map((m) => m.type)).toEqual(["session", "retry", "session", "text", "result"]);
		expect(collected[1].message ?? "").toMatch(/summarizer failed .* dropped the oldest 1 message\(s\)/);
		// The retry prompt carries the truncation notice + the verbatim tail.
		expect(stub.runPrompts[1]).toContain("truncated automatically after summarization failed");
		expect(stub.runPrompts[1]).toContain("assistant: m2");
	});

	it("surfaces the original overflow error when both compaction and the truncation fallback fail", async () => {
		const stub = new StubAgent();
		stub.runStreams.push(overflowStream("context_length_exceeded: prompt too large"));
		stub.runStreams.push(overflowStream("context_length_exceeded: prompt too large"));
		stub.compactSpy.mockRejectedValue(new Error("compactor LLM unreachable"));

		const collected: AgentMessage[] = [];
		for await (const msg of runWithAutoCompact(stub as unknown as IAgent, {
			prompt: "p",
			history: [
				{ role: "user", content: "m1" },
				{ role: "assistant", content: "m2" },
			],
			maxAttempts: 2,
		})) {
			collected.push(msg);
		}

		// Attempt 1: overflow → summarizer fails → truncation fallback notice.
		// Attempt 2: overflow again → budget exhausted → original overflow error.
		expect(collected.map((m) => m.type)).toEqual(["session", "retry", "session", "error"]);
		const last = collected.at(-1);
		expect(last?.kind?.kind).toBe("context_overflow");
		expect(last?.message).toContain("context_length_exceeded: prompt too large");
		expect(last?.message).toMatch(/budget exhausted after 2 attempt\(s\)/);
	});

	it("compacts proactively before the first attempt when the token threshold is exceeded", async () => {
		const stub = new StubAgent();
		stub.runStreams.push(textStream("ok"));

		const collected: AgentMessage[] = [];
		for await (const msg of runWithAutoCompact(stub as unknown as IAgent, {
			prompt: "p",
			history: [
				{ role: "user", content: "a fairly long earlier message that will surely exceed ten tokens" },
				{ role: "assistant", content: "an equally long assistant reply that will surely exceed ten tokens" },
			],
			compactThresholdTokens: 10,
		})) {
			collected.push(msg);
		}

		// No overflow happened — the proactive path compacted first, then the
		// single attempt ran with the carry-forward prompt (the stub's canned
		// compaction reports messageCount 4 — the count is not under test here).
		expect(stub.compactSpy).toHaveBeenCalledTimes(1);
		expect(stub.runPrompts).toHaveLength(1);
		expect(stub.runPrompts[0]).toMatch(/\[carry-forward summary from earlier \d+ message\(s\)\]/);
		expect(collected.map((m) => m.type)).toEqual(["retry", "session", "text", "result"]);
		expect(collected[0].message ?? "").toMatch(/proactively compacted 2 prior message\(s\)/);
		expect(collected[0].attempt).toBe(1);
	});

	it("proceeds un-compacted when proactive compaction fails", async () => {
		const stub = new StubAgent();
		stub.runStreams.push(textStream("ok"));
		stub.compactSpy.mockRejectedValueOnce(new Error("compactor LLM unreachable"));

		const collected: AgentMessage[] = [];
		for await (const msg of runWithAutoCompact(stub as unknown as IAgent, {
			prompt: "p",
			history: [
				{ role: "user", content: "a fairly long earlier message that will surely exceed ten tokens" },
			],
			compactThresholdTokens: 10,
		})) {
			collected.push(msg);
		}

		// Proactive compaction is best-effort: nothing has overflowed yet, so
		// the run proceeds with the original prompt.
		expect(collected.map((m) => m.type)).toEqual(["retry", "session", "text", "result"]);
		expect(collected[0].message ?? "").toMatch(/proactive compaction failed .* proceeding un-compacted/);
		expect(stub.runPrompts).toEqual(["p"]);
	});

	it("emits a structured baseline (summary + verbatim tail) via onCompactionBaseline", async () => {
		const stub = new StubAgent();
		stub.runStreams.push(overflowStream());
		stub.runStreams.push(textStream("ok"));

		const baselines: Array<{ baseline: ConversationMessage[]; result: CompactContextResult }> = [];
		for await (const _msg of runWithAutoCompact(stub as unknown as IAgent, {
			prompt: "p",
			history: [
				{ role: "user", content: "earlier 1" },
				{ role: "assistant", content: "earlier 2" },
				{ role: "user", content: "earlier 3" },
				{ role: "assistant", content: "earlier 4" },
			],
			keepRecentTokens: 1, // tiny budget → only the newest message survives verbatim
			onCompactionBaseline: (baseline, result) => baselines.push({ baseline, result }),
		})) {
			void _msg;
		}

		expect(baselines).toHaveLength(1);
		const { baseline, result } = baselines[0];
		expect(result.summary).toContain("[COMPACTED: HARD");
		// baseline = [system carry-forward summary, ...verbatim tail]
		expect(baseline[0].role).toBe("system");
		expect(baseline[0].content).toContain("[Carry-forward summary from earlier 4 message(s)]");
		expect(baseline[0].content).toContain(result.summary);
		expect(baseline.slice(1)).toEqual([{ role: "assistant", content: "earlier 4" }]);
	});

	it("surfaces the last overflow error annotated with the exhausted budget", async () => {
		const stub = new StubAgent();
		stub.runStreams.push(overflowStream());
		stub.runStreams.push(overflowStream());
		stub.runStreams.push(overflowStream());

		const collected: AgentMessage[] = [];
		for await (const msg of runWithAutoCompact(stub as unknown as IAgent, {
			prompt: "p",
			history: [{ role: "user", content: "m1" }],
			maxAttempts: 2,
		})) {
			collected.push(msg);
		}

		// First attempt: session only (overflow suppressed).
		// Notice. Second attempt: session only (overflow suppressed).
		// Budget exhausted → final error.
		expect(collected.map((m) => m.type)).toEqual(["session", "retry", "session", "error"]);
		const last = collected.at(-1);
		expect(last?.kind?.kind).toBe("context_overflow");
		expect(last?.message).toContain("context_length_exceeded: prompt too large");
		expect(last?.message).toMatch(/budget exhausted after 2 attempt\(s\)/);
	});

	it("respects a non-overflow error and surfaces it unchanged", async () => {
		const stub = new StubAgent();
		async function* upstreamError(): AsyncGenerator<AgentMessage> {
			yield { type: "session", sessionId: "s1" };
			yield {
				type: "error",
				sessionId: "s1",
				message: "401 unauthorized",
				kind: { kind: "auth_failure", status: 401, message: "401 unauthorized" },
			};
		}
		stub.runStreams.push(upstreamError());

		const collected: AgentMessage[] = [];
		for await (const msg of runWithAutoCompact(stub as unknown as IAgent, {
			prompt: "p",
			history: [{ role: "user", content: "m1" }],
		})) {
			collected.push(msg);
		}

		expect(collected.map((m) => m.type)).toEqual(["session", "error"]);
		expect((collected.at(-1) as { kind?: { kind: string } }).kind?.kind).toBe("auth_failure");
		expect(stub.compactSpy).not.toHaveBeenCalled();
	});

	it("clamps maxAttempts to a minimum of 1", async () => {
		const stub = new StubAgent();
		stub.runStreams.push(overflowStream());
		stub.runStreams.push(textStream("ok"));

		const collected: AgentMessage[] = [];
		for await (const msg of runWithAutoCompact(stub as unknown as IAgent, {
			prompt: "p",
			history: [{ role: "user", content: "m1" }],
			maxAttempts: 0, // explicit zero → clamped to 1, so no retry at all
		})) {
			collected.push(msg);
		}

		// Budget exhausted immediately, so we get the first session + final error.
		expect(collected.map((m) => m.type)).toEqual(["session", "error"]);
	});
});
