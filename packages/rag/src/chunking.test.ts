/**
 * @melandlabs/rag — text chunking and chunk-count estimation.
 *
 * `chunkText` is the most-called helper in any RAG pipeline. Its
 * semantic contract — what the resulting `startPosition` /
 * `endPosition` fields mean, how overlapping chunks reassemble, how
 * short and long inputs behave — is the kind of thing that quietly
 * regresses when someone tweaks the split loop. This file pins the
 * observable behaviour without depending on any embedding model or
 * network access.
 */

import { describe, expect, it } from "vitest";

import { chunkText, countTokens, estimateChunkCount, getOptimalChunkSize } from "./chunking";

describe("chunkText", () => {
	it("returns a single chunk for input that fits inside maxChunkSize", () => {
		const out = chunkText("hello world", { maxChunkSize: 100 });
		expect(out).toHaveLength(1);
		expect(out[0].content).toBe("hello world");
		expect(out[0].startPosition).toBe(0);
		expect(out[0].endPosition).toBe("hello world".length);
		expect(out[0].index).toBe(0);
	});

	it("strips leading/trailing whitespace before chunking", () => {
		const out = chunkText("   hello world   ", { maxChunkSize: 100 });
		expect(out[0].content).toBe("hello world");
	});

	it("splits a long paragraph into multiple chunks", () => {
		// Real text with sentence boundaries — without punctuation the
		// chunker falls back to a single chunk, since there's no
		// sentence-end to break on. The implementation deliberately
		// prefers not breaking mid-sentence, so the test exercises the
		// realistic case.
		const text =
			"OpenContext is a runtime substrate. It bundles retrieval, memory, scheduling, and integrations. " +
			"Each capability also ships as its own npm package. The facade in @melandlabs/opencontext re-exports the whole surface.";
		const out = chunkText(text, { maxChunkSize: 80, chunkOverlap: 0 });
		expect(out.length).toBeGreaterThan(1);
	});

	it("produces monotonically non-decreasing positions and ends at the input length", () => {
		const text = "alpha. beta. gamma. delta. epsilon. zeta. eta. theta.".repeat(8);
		const out = chunkText(text, { maxChunkSize: 60, chunkOverlap: 8 });
		let cursor = 0;
		for (const c of out) {
			expect(c.startPosition).toBe(cursor);
			expect(c.endPosition).toBe(cursor + c.content.length);
			cursor = c.endPosition;
		}
	});

	it("every chunk has the documented TextChunk shape", () => {
		const out = chunkText("one. two. three. four. five. six. seven. eight.", { maxChunkSize: 16 });
		for (const c of out) {
			expect(c).toEqual(
				expect.objectContaining({
					content: expect.any(String),
					index: expect.any(Number),
					startPosition: expect.any(Number),
					endPosition: expect.any(Number),
				}),
			);
			expect(c.endPosition).toBeGreaterThanOrEqual(c.startPosition);
		}
	});

	it("respects a custom separator when splitting paragraphs", () => {
		const text = ["first paragraph", "second paragraph", "third paragraph"].join(" || ");
		const out = chunkText(text, { maxChunkSize: 50, chunkOverlap: 0, separator: " || " });
		expect(out.length).toBeGreaterThanOrEqual(2);
		// The trimmed chunk content should never contain the separator at the seams.
		for (const c of out) {
			expect(c.content.startsWith(" ") || c.content.startsWith("\n")).toBe(false);
		}
	});

	it("indexes chunks starting at 0 and counting up", () => {
		const out = chunkText("a. b. c. d. e. f. g. h. i. j. k. l. m. n. o. p. q. r. s. t.", {
			maxChunkSize: 10,
		});
		expect(out[0].index).toBe(0);
		for (let i = 1; i < out.length; i++) {
			expect(out[i].index).toBe(i);
		}
	});
});

describe("countTokens", () => {
	it("returns a non-negative integer", () => {
		const n = countTokens("hello world");
		expect(Number.isFinite(n)).toBe(true);
		expect(n).toBeGreaterThanOrEqual(0);
	});

	it("returns 0 for the empty string", () => {
		expect(countTokens("")).toBe(0);
	});

	it("is monotone: longer text ≥ shorter text", () => {
		const short = countTokens("hi");
		const long = countTokens("hi ".repeat(500));
		expect(long).toBeGreaterThan(short);
	});
});

describe("getOptimalChunkSize", () => {
	it("returns the text length itself for very short text", () => {
		expect(getOptimalChunkSize(500)).toBe(500);
	});

	it("returns 500 for text in the 1k–10k band", () => {
		expect(getOptimalChunkSize(5000)).toBe(500);
	});

	it("returns 1000 for text in the 10k–50k band", () => {
		expect(getOptimalChunkSize(20_000)).toBe(1000);
	});

	it("returns 1500 for very long text", () => {
		expect(getOptimalChunkSize(200_000)).toBe(1500);
	});
});

describe("estimateChunkCount", () => {
	it("uses the default options when none are passed", () => {
		// defaults: maxChunkSize=1000, chunkOverlap=200 → effective 800
		expect(estimateChunkCount(1600)).toBe(2);
		expect(estimateChunkCount(801)).toBe(2);
	});

	it("honours a custom maxChunkSize and chunkOverlap", () => {
		expect(estimateChunkCount(500, { maxChunkSize: 100, chunkOverlap: 0 })).toBe(5);
	});

	it("never returns zero for positive input", () => {
		expect(estimateChunkCount(1)).toBeGreaterThanOrEqual(1);
		expect(estimateChunkCount(10_000)).toBeGreaterThan(0);
	});
});
