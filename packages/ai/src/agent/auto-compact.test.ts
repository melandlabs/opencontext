/**
 * Unit tests for `runWithAutoCompact`.
 *
 * Uses a hand-rolled IAgent stub so we can deterministically:
 *   - emit a `kind: "context_overflow"` error on the first attempt
 *   - emit a normal text+result stream on the retry
 *   - assert the wrapper interleaves the synthetic notice + retry messages
 *     correctly, and never re-emits the underlying overflow error.
 */
import { describe, expect, it, vi } from "vitest";

import { runWithAutoCompact } from "./auto-compact";
import type { AgentMessage, AgentOptions, CompactContextResult, IAgent } from "./types";

class StubAgent implements Pick<IAgent, "run" | "compactContext"> {
	runStreams: Array<AsyncGenerator<AgentMessage>> = [];
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

	async *run(_prompt: string, _options?: AgentOptions): AsyncGenerator<AgentMessage> {
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

async function* overflowStream(): AsyncGenerator<AgentMessage> {
	yield { type: "session", sessionId: "s1" };
	yield {
		type: "error",
		sessionId: "s1",
		message: "context_length_exceeded: prompt too large",
		kind: { kind: "context_overflow", message: "context_length_exceeded: prompt too large" },
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

	it("compacts on overflow and yields a synthetic notice before the retry stream", async () => {
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
		// Then: synthetic notice.
		// Then: retry stream (session + text + result).
		expect(collected.map((m) => m.type)).toEqual(["session", "scheduleNotice", "session", "text", "result"]);
		expect(collected[1].type).toBe("scheduleNotice");
		expect((collected[1] as { message?: string }).message ?? "").toMatch(/\[auto-compact\] Compacted/);
		expect(stub.compactSpy).toHaveBeenCalledTimes(1);
	});

	it("passes the original history + level into compactContext", async () => {
		const stub = new StubAgent();
		stub.runStreams.push(overflowStream());
		stub.runStreams.push(textStream("ok"));

		const history = [
			{ role: "user" as const, content: "m1" },
			{ role: "assistant" as const, content: "m2" },
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

	it("surfaces a final context_overflow error when the budget is exhausted", async () => {
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
		expect(collected.map((m) => m.type)).toEqual(["session", "scheduleNotice", "session", "error"]);
		const last = collected.at(-1);
		expect(last?.kind?.kind).toBe("context_overflow");
		expect((last as { message?: string }).message).toMatch(/budget exhausted/);
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
