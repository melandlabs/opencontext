import { describe, expect, it, vi } from "vitest";
import { presentMessageContext } from "./message-context";
import { applyReranker } from "./reranker";
import type { UnifiedMemorySearchResult } from "./utilities";

const hit = (id: string, messageSequence: number, extra = {}): UnifiedMemorySearchResult => ({
	type: "memory",
	id,
	content: `original ${id}`,
	similarity: 0.5,
	metadata: { userId: "alice", messageSequence, sourceChunkIndex: 0, ...extra },
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
		expect(result[0].content).toContain("messageSequence: 3");
		expect(result[0].content).toContain("Historical facts retain their original meaning.");
		expect(result[0].content).toContain("prioritize the message text and available timestamps");
		expect(result[0].content).toContain("use messageSequence as a secondary clue");
		expect(result[0].content).not.toMatch(/[\u3400-\u9fff]/);
		expect(result[0].content).not.toContain("timestamp:");
		expect(candidates[1].content).toBe("original b");
		expect(rerank.mock.calls[0][0].candidates[0].content).toBe("original a");
	});

	it("preserves rank across chunks, includes supplied timestamps and does not modify other sources", () => {
		const knowledge: UnifiedMemorySearchResult = { ...hit("doc", 1), type: "knowledge" };
		const result = presentMessageContext([
			hit("last", 4, { sourceChunkIndex: 2 }),
			knowledge,
			hit("first", 4, { sourceChunkIndex: 0, timestamp: 123000, role: "assistant" }),
		]);
		expect(result.map((item) => item.id)).toEqual(["last", "doc", "first"]);
		expect(result[2].content).toContain("timestamp: 123000");
		expect(result[2].content).toContain("role: assistant");
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
