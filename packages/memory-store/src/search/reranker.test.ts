/**
 * Tests for the optional `Reranker` adapter.
 *
 * The contract is: deterministic ordering, topK slicing, and stable
 * ordering of candidates the reranker omitted (preserves the original
 * merge order for those, including any `rrfScore` / `similarity`
 * tie-break).
 */
import { describe, expect, it, vi } from "vitest";
import { IdentityReranker, applyReranker } from "./reranker";
import { type UnifiedMemorySearchResult, mergeUnifiedMemorySearchResultsRrf } from "./utilities";

function makeHit(
	type: UnifiedMemorySearchResult["type"],
	id: string,
	similarity: number,
): UnifiedMemorySearchResult {
	return {
		type,
		id,
		content: `content of ${id}`,
		similarity,
		metadata: {},
	};
}

describe("IdentityReranker", () => {
	it("preserves order and assigns decaying scores", async () => {
		const reranker = new IdentityReranker();
		const scores = await reranker.rerank({
			query: "anything",
			candidates: [
				{ id: "a", content: "alpha" },
				{ id: "b", content: "beta" },
				{ id: "c", content: "gamma" },
			],
		});
		expect(scores.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
		expect(scores[0]?.score).toBeCloseTo(1);
		expect(scores[1]?.score).toBeCloseTo(0.5);
		expect(scores[2]?.score).toBeCloseTo(1 / 3);
	});

	it("honours topK", async () => {
		const reranker = new IdentityReranker();
		const scores = await reranker.rerank({
			query: "anything",
			topK: 2,
			candidates: [
				{ id: "a", content: "alpha" },
				{ id: "b", content: "beta" },
				{ id: "c", content: "gamma" },
			],
		});
		expect(scores).toHaveLength(2);
	});
});

describe("applyReranker", () => {
	it("returns the input unchanged when no reranker is configured", async () => {
		const hits = [makeHit("memory", "m1", 0.9), makeHit("memory", "m2", 0.7)];
		const out = await applyReranker(undefined, "q", hits);
		expect(out).toBe(hits);
	});

	it("returns an empty array for empty input", async () => {
		const out = await applyReranker(new IdentityReranker(), "q", []);
		expect(out).toEqual([]);
	});

	it("rewrites metadata with the reranker score", async () => {
		const hits = [makeHit("memory", "m1", 0.9), makeHit("memory", "m2", 0.7)];
		const reranker = {
			rerank: vi.fn().mockResolvedValue([
				{ id: "m2", score: 0.95 },
				{ id: "m1", score: 0.4 },
			]),
		};
		const out = await applyReranker(reranker, "q", hits);
		expect(out.map((h) => h.id)).toEqual(["m2", "m1"]);
		expect(out[0]?.metadata.rerankerScore).toBe(0.95);
		expect(out[1]?.metadata.rerankerScore).toBe(0.4);
	});

	it("appends omitted candidates at the tail in original order", async () => {
		const hits = [makeHit("memory", "m1", 0.9), makeHit("memory", "m2", 0.7), makeHit("insight", "i1", 0.8)];
		const reranker = {
			rerank: vi.fn().mockResolvedValue([{ id: "m2", score: 0.9 }]),
		};
		const out = await applyReranker(reranker, "q", hits);
		expect(out.map((h) => h.id)).toEqual(["m2", "m1", "i1"]);
		expect(out[1]?.metadata.rerankerScore).toBeUndefined();
		expect(out[2]?.metadata.rerankerScore).toBeUndefined();
	});

	it("does not duplicate when reranker echoes the same id twice", async () => {
		const hits = [makeHit("memory", "m1", 0.9), makeHit("memory", "m2", 0.7)];
		const reranker = {
			rerank: vi.fn().mockResolvedValue([
				{ id: "m1", score: 0.8 },
				{ id: "m1", score: 0.5 },
			]),
		};
		const out = await applyReranker(reranker, "q", hits);
		expect(out.map((h) => h.id)).toEqual(["m1", "m2"]);
	});

	it("preserves an existing rrfScore through the rewrite", async () => {
		const rrfHits = mergeUnifiedMemorySearchResultsRrf(
			[
				{ name: "memory-semantic", hits: [makeHit("memory", "m1", 0.9)] },
				{ name: "memory-bm25", hits: [makeHit("memory", "m1", 0.4)] },
			],
			10,
		);
		const reranker = {
			rerank: vi.fn().mockResolvedValue([{ id: "m1", score: 0.95 }]),
		};
		const out = await applyReranker(reranker, "q", rrfHits);
		expect(out[0]?.metadata.rrfScore).toBeGreaterThan(0);
		expect(out[0]?.metadata.rerankerScore).toBe(0.95);
	});
});
