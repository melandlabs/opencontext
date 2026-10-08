import { describe, expect, it } from "vitest";
import { chunkTextByEstimatedTokens, chunkTextByTokenBudget } from "./text-chunking";
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

describe("chunkTextByTokenBudget", () => {
	it("uses the supplied tokenizer for both content and overlap, preserving every source character", () => {
		const text = "alpha β emoji😀 code_xyz.\n".repeat(12);
		const countTokens = (value: string) => Array.from(value).length;
		const chunks = chunkTextByTokenBudget(text, { maxTokens: 24, overlapTokens: 4, countTokens });
		let covered = 0;
		for (const chunk of chunks) {
			expect(chunk.startPosition).toBeLessThanOrEqual(covered);
			expect(chunk.endPosition).toBeGreaterThan(covered);
			expect(chunk.content).toBe(text.slice(chunk.startPosition, chunk.endPosition));
			expect(countTokens(chunk.content)).toBeLessThanOrEqual(24);
			expect(countTokens(text.slice(chunk.startPosition, covered))).toBeLessThanOrEqual(4);
			expect(chunk.content).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/u);
			covered = chunk.endPosition;
		}
		expect(covered).toBe(text.length);
	});

	it("rejects invalid counters and impossible budgets instead of emitting an oversized chunk", () => {
		expect(() => chunkTextByTokenBudget("text", { countTokens: () => Number.NaN })).toThrow("Token counter");
		expect(() =>
			chunkTextByTokenBudget("x", { maxTokens: 1, overlapTokens: 0, countTokens: () => 2 }),
		).toThrow("cannot fit");
	});
});
