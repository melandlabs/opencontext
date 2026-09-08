import { describe, expect, it } from "vitest";
import { chunkTextByEstimatedTokens } from "./text-chunking";
import { estimateTokens } from "./tokens";

describe("chunkTextByEstimatedTokens", () => {
	it("keeps short text as one exact chunk", () => {
		const text = "A short message.\nWith its original formatting.";
		expect(chunkTextByEstimatedTokens(text)).toEqual([
			{ chunkIndex: 0, startPosition: 0, endPosition: text.length, content: text },
		]);
	});

	it("uses the token budget, overlap, natural boundaries, and exact offsets", () => {
		const paragraphs = Array.from(
			{ length: 18 },
			(_, index) => `Paragraph ${index}. ${"detail ".repeat(35).trim()}.`,
		);
		const text = paragraphs.join("\n\n");
		const chunks = chunkTextByEstimatedTokens(text);

		expect(chunks.length).toBeGreaterThan(1);
		for (const [index, chunk] of chunks.entries()) {
			expect(chunk.chunkIndex).toBe(index);
			expect(chunk.content).toBe(text.slice(chunk.startPosition, chunk.endPosition));
			expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(400);
			if (index > 0) {
				const previous = chunks[index - 1];
				expect(chunk.startPosition).toBeLessThan(previous.endPosition);
				expect(estimateTokens(text.slice(chunk.startPosition, previous.endPosition))).toBeLessThanOrEqual(80);
			}
		}
		expect(chunks.at(-1)?.endPosition).toBe(text.length);
	});

	it("rejects an overlap that cannot make forward progress", () => {
		expect(() => chunkTextByEstimatedTokens("text", { maxTokens: 10, overlapTokens: 10 })).toThrow(
			"overlapTokens must be smaller than maxTokens",
		);
	});
});
