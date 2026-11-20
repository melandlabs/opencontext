import { afterEach, describe, expect, it, vi } from "vitest";
import { formatEvidenceTimestamp, presentMessageContext } from "./message-context";
import { applyReranker } from "./reranker";
import type { UnifiedMemorySearchResult } from "./utilities";

const hit = (id: string, messageSequence: number, extra = {}): UnifiedMemorySearchResult => ({
	type: "memory",
	id,
	content: `original ${id}`,
	similarity: 0.5,
	metadata: { userId: "alice", messageSequence, sourceChunkIndex: 0, ...extra },
});

afterEach(() => {
	process.env.OPENCONTEXT_MESSAGE_CONTEXT_MODE = undefined;
});

describe("message evidence presentation", () => {
	it("reranks raw text, selects Top-K and preserves relevance order and scores", async () => {
		const candidates = [hit("a", 1), hit("b", 2), hit("c", 3)];
		const rerank = vi.fn().mockResolvedValue([
			{ id: "c", score: 0.99 },
			{ id: "b", score: 0.8 },
			{ id: "a", score: 0.1 },
		]);
		const ranked = await applyReranker({ rerank }, "query", candidates);
		const result = presentMessageContext(ranked.slice(0, 2));
		expect(result.map((item) => item.id)).toEqual(["c", "b"]);
		expect(result[0].metadata?.rerankerScore).toBe(0.99);
		// Compact mode: the evidence stays readable, no guidance boilerplate.
		expect(result[0].content).toBe("original c");
		expect(result[0].content).not.toContain("messageSequence");
		expect(result[0].content).not.toContain("Message order guidance");
		expect(result[0].content).not.toMatch(/[㐀-鿿]/);
		expect(candidates[1].content).toBe("original b");
		expect(rerank.mock.calls[0][0].candidates[0].content).toBe("original a");
	});

	it("renders the event time and the speaker into the evidence text", () => {
		const result = presentMessageContext([
			hit("first", 4, { timestamp: Date.UTC(2026, 9, 21, 5, 0), role: "assistant" }),
		]);
		expect(result[0].content).toBe("[2026-10-21 05:00] assistant: original first");
	});

	it("renders the speaker alone when the memory carries no event time", () => {
		const result = presentMessageContext([hit("undated", 4, { role: "user" })]);
		expect(result[0].content).toBe("[user] original undated");
	});

	it("does not invent a date for a memory without one", () => {
		const result = presentMessageContext([hit("plain", 4)]);
		expect(result[0].content).toBe("original plain");
	});

	it("keeps the legacy guidance rendering available behind the mode switch", () => {
		process.env.OPENCONTEXT_MESSAGE_CONTEXT_MODE = "legacy";
		const result = presentMessageContext([hit("legacy", 3, { timestamp: 123000, role: "assistant" })]);
		expect(result[0].content).toContain("messageSequence: 3");
		expect(result[0].content).toContain("Historical facts retain their original meaning.");
		expect(result[0].content).toContain("prioritize the message text and available timestamps");
		expect(result[0].content).toContain("timestamp: 123000");
	});

	it("preserves rank across chunks and does not modify other sources", () => {
		const knowledge: UnifiedMemorySearchResult = { ...hit("doc", 1), type: "knowledge" };
		const result = presentMessageContext([
			hit("last", 4, { sourceChunkIndex: 2 }),
			knowledge,
			hit("first", 4, { sourceChunkIndex: 0, timestamp: 123000, role: "assistant" }),
		]);
		expect(result.map((item) => item.id)).toEqual(["last", "doc", "first"]);
		expect(result[2].content).toBe("[1970-01-01 00:02] assistant: original first");
		expect(result[1]).toBe(knowledge);
	});

	it("keeps different users and legacy unnumbered results independent", () => {
		const legacy = { ...hit("legacy", 1), metadata: {} };
		const result = presentMessageContext([
			hit("a3", 3),
			hit("b1", 1, { userId: "bob" }),
			legacy,
			hit("a1", 1),
		]);
		expect(result.map((item) => item.id)).toEqual(["a3", "b1", "legacy", "a1"]);
		expect(result[2]).toBe(legacy);
	});
});

describe("formatEvidenceTimestamp", () => {
	it("formats epoch milliseconds as UTC YYYY-MM-DD HH:MM", () => {
		expect(formatEvidenceTimestamp(Date.UTC(2026, 0, 2, 3, 4))).toBe("2026-01-02 03:04");
	});

	it("returns undefined for values that are not a usable time", () => {
		expect(formatEvidenceTimestamp(Number.NaN)).toBeUndefined();
		expect(formatEvidenceTimestamp(Number.POSITIVE_INFINITY)).toBeUndefined();
	});
});
