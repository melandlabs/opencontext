/**
 * Tests for the additions to `search/utilities`:
 *   - the optional `mergeStrategy` ("similarity" | "rrf") on
 *     `UnifiedMemorySearchInput`
 *   - the RRF merge function and its tie-break semantics
 *   - the `normalizeUnifiedMemoryMergeStrategy` guard
 *   - the optional `asOf` ISO-8601 timestamp on `UnifiedMemorySearchInput`
 *
 * Backward compatibility: the legacy 2-argument `mergeUnifiedMemorySearchResults`
 * call must keep sorting by similarity exactly as before.
 */
import { describe, expect, it } from "vitest";

import {
	type UnifiedMemorySearchInput,
	type UnifiedMemorySearchResult,
	mergeUnifiedMemorySearchResults,
	mergeUnifiedMemorySearchResultsRrf,
	normalizeUnifiedMemoryMergeStrategy,
} from "./utilities";

function makeResult(
	overrides: Partial<UnifiedMemorySearchResult> & { type: UnifiedMemorySearchResult["type"]; id: string },
): UnifiedMemorySearchResult {
	return {
		content: `content-${overrides.id}`,
		similarity: 0,
		metadata: {},
		...overrides,
	};
}

describe("mergeUnifiedMemorySearchResults backward compatibility", () => {
	it("keeps the legacy similarity sort when called with 2 arguments", () => {
		const a = makeResult({ type: "memory", id: "a", similarity: 0.3 });
		const b = makeResult({ type: "memory", id: "b", similarity: 0.9 });
		const c = makeResult({ type: "memory", id: "c", similarity: 0.6 });
		const merged = mergeUnifiedMemorySearchResults([a, b, c], 5);
		expect(merged.map((hit) => hit.id)).toEqual(["b", "c", "a"]);
	});

	it("treats strategy:'similarity' identically to omitting the option", () => {
		const a = makeResult({ type: "knowledge", id: "k1", similarity: 0.4 });
		const b = makeResult({ type: "memory", id: "m1", similarity: 0.7 });
		const legacy = mergeUnifiedMemorySearchResults([a, b], 10);
		const explicit = mergeUnifiedMemorySearchResults([a, b], 10, { strategy: "similarity" });
		expect(explicit.map((hit) => hit.id)).toEqual(legacy.map((hit) => hit.id));
	});

	it("applies the legacy limit + (type, id) tie-break on identical similarities", () => {
		const hits = [
			makeResult({ type: "memory", id: "m2", similarity: 0.5 }),
			makeResult({ type: "memory", id: "m1", similarity: 0.5 }),
			makeResult({ type: "knowledge", id: "k1", similarity: 0.5 }),
		];
		const merged = mergeUnifiedMemorySearchResults(hits, 2);
		expect(merged).toHaveLength(2);
		// tie-break: knowledge < memory lexicographically
		expect(merged[0]?.type).toBe("knowledge");
		expect(merged[0]?.id).toBe("k1");
		expect(merged[1]?.id).toBe("m1");
	});
});

describe("normalizeUnifiedMemoryMergeStrategy", () => {
	it("returns 'rrf' for the rrf literal", () => {
		expect(normalizeUnifiedMemoryMergeStrategy("rrf")).toBe("rrf");
	});
	it("returns 'similarity' for unknown / legacy / non-string values", () => {
		expect(normalizeUnifiedMemoryMergeStrategy("garbage")).toBe("similarity");
		expect(normalizeUnifiedMemoryMergeStrategy(undefined)).toBe("similarity");
		expect(normalizeUnifiedMemoryMergeStrategy(null)).toBe("similarity");
		expect(normalizeUnifiedMemoryMergeStrategy(42)).toBe("similarity");
	});
});

describe("mergeUnifiedMemorySearchResultsRrf", () => {
	it("sums reciprocal ranks and exposes the rrfScore in metadata", () => {
		const listA = [makeResult({ type: "memory", id: "m1", similarity: 0.9 })];
		const listB = [makeResult({ type: "memory", id: "m1", similarity: 0.4 })];
		const merged = mergeUnifiedMemorySearchResultsRrf(
			[
				{ name: "memory-semantic", hits: listA },
				{ name: "memory-bm25", hits: listB },
			],
			10,
		);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.metadata.rrfScore).toBeCloseTo(1 / 61 + 1 / 61);
	});

	it("produces a deterministic sort across 4 lists", () => {
		const merged = mergeUnifiedMemorySearchResultsRrf(
			[
				{
					name: "memory-semantic",
					hits: [
						makeResult({ type: "memory", id: "m1", similarity: 0.9 }),
						makeResult({ type: "memory", id: "m2", similarity: 0.7 }),
					],
				},
				{
					name: "memory-bm25",
					hits: [
						makeResult({ type: "memory", id: "m2", similarity: 0.5 }),
						makeResult({ type: "memory", id: "m3", similarity: 0.3 }),
					],
				},
				{
					name: "insights",
					hits: [makeResult({ type: "insight", id: "i1", similarity: 0.95 })],
				},
				{
					name: "knowledge",
					hits: [makeResult({ type: "knowledge", id: "k1", similarity: 0.6 })],
				},
			],
			10,
		);
		// m2 surfaces in two lists, so should outrank the single-list entries.
		// Tie-break is (type, id) lex, so `knowledge` < `memory` < `insight`.
		expect(merged.map((hit) => `${hit.type}:${hit.id}`)).toEqual([
			"memory:m2",
			"insight:i1",
			"knowledge:k1",
			"memory:m1",
			"memory:m3",
		]);
	});

	it("returns an empty array when no lists are provided", () => {
		expect(mergeUnifiedMemorySearchResultsRrf([], 10)).toEqual([]);
	});
});

describe("UnifiedMemorySearchInput new fields", () => {
	it("accepts an asOf timestamp and mergeStrategy", () => {
		const input: UnifiedMemorySearchInput = {
			userId: "u1",
			query: "q",
			asOf: "2026-01-15T00:00:00Z",
			mergeStrategy: "rrf",
		};
		expect(input.asOf).toBe("2026-01-15T00:00:00Z");
		expect(input.mergeStrategy).toBe("rrf");
	});

	it("keeps the legacy shape when neither field is supplied", () => {
		const input: UnifiedMemorySearchInput = { userId: "u1", query: "q" };
		expect(input.asOf).toBeUndefined();
		expect(input.mergeStrategy).toBeUndefined();
	});
});
