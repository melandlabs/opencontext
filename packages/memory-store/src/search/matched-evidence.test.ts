import { describe, expect, it } from "vitest";
import { mergeMatchedEvidence, renderMatchedEvidence, withMatchedEvidence } from "./matched-evidence";

describe("matched evidence", () => {
	it("coalesces overlapping windows without losing either source chunk", () => {
		const first = withMatchedEvidence(
			{
				content: "0123456",
				metadata: { sourceChunkId: "a", sourceStartPosition: 0, sourceEndPosition: 7 },
			},
			"memory-semantic",
			1,
		);
		const second = withMatchedEvidence(
			{
				content: "456789",
				metadata: { sourceChunkId: "b", sourceStartPosition: 4, sourceEndPosition: 10 },
			},
			"memory-bm25",
			2,
		);
		const merged = mergeMatchedEvidence(first, second);
		expect(renderMatchedEvidence(merged)).toBe("[Matched excerpt 1]\n0123456789");
		expect(
			((merged.metadata as Record<string, unknown>).matchedSpans as Array<{ sourceChunkId: string }>).map(
				(span) => span.sourceChunkId,
			),
		).toEqual(["a", "b"]);
	});

	it("records both chunk ids when channels select the same exact window", () => {
		const first = withMatchedEvidence(
			{ content: "answer", metadata: { sourceChunkId: "a", sourceStartPosition: 0, sourceEndPosition: 6 } },
			"memory-semantic",
			1,
		);
		const second = withMatchedEvidence(
			{ content: "answer", metadata: { sourceChunkId: "b", sourceStartPosition: 0, sourceEndPosition: 6 } },
			"memory-bm25",
			1,
		);
		const inputsBefore = structuredClone([first, second]);
		const merged = mergeMatchedEvidence(first, second);
		expect([first, second]).toEqual(inputsBefore);
		expect((merged.metadata as Record<string, unknown>).matchedSpans).toMatchObject([
			{ sourceChunkIds: ["a", "b"], channels: [{ name: "memory-semantic" }, { name: "memory-bm25" }] },
		]);
	});
});
