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
	listNameToChannel,
	materializeSignals,
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

describe("listNameToChannel", () => {
	it("maps memory-semantic to semantic", () => {
		expect(listNameToChannel("memory-semantic")).toBe("semantic");
	});

	it("maps both memory-bm25 and memory-lexical to lexical (legacy + current naming)", () => {
		expect(listNameToChannel("memory-bm25")).toBe("lexical");
		expect(listNameToChannel("memory-lexical")).toBe("lexical");
	});

	it("maps memory-entity to entity", () => {
		expect(listNameToChannel("memory-entity")).toBe("entity");
	});

	it("returns undefined for non-channel list names (insights, knowledge, summary)", () => {
		expect(listNameToChannel("insights")).toBeUndefined();
		expect(listNameToChannel("knowledge")).toBeUndefined();
		expect(listNameToChannel("summary")).toBeUndefined();
		expect(listNameToChannel("")).toBeUndefined();
	});
});

describe("materializeSignals", () => {
	it("returns undefined when the hit is not in any channel list", () => {
		const m1 = makeResult({ type: "memory", id: "m1", similarity: 0.9 });
		const m2 = makeResult({ type: "memory", id: "m2", similarity: 0.8 });
		const out = materializeSignals([{ name: "memory-semantic", hits: [m1] }], m2);
		expect(out).toBeUndefined();
	});

	it("populates channels + per-channel similarity for a single-channel hit", () => {
		const m1 = makeResult({ type: "memory", id: "m1", similarity: 0.91 });
		const out = materializeSignals([{ name: "memory-semantic", hits: [m1] }], m1);
		expect(out).toEqual({ channels: ["semantic"], semantic: 0.91 });
	});

	it("populates every channel the hit appeared in (semantic + lexical + entity)", () => {
		const m1 = makeResult({ type: "memory", id: "m1", similarity: 0.91 });
		const out = materializeSignals(
			[
				{ name: "memory-semantic", hits: [m1] },
				{ name: "memory-bm25", hits: [makeResult({ type: "memory", id: "m1", similarity: 0.45 })] },
				{ name: "memory-entity", hits: [makeResult({ type: "memory", id: "m1", similarity: 0.85 })] },
				{ name: "insights", hits: [] },
			],
			m1,
		);
		expect(out?.channels).toEqual(["semantic", "lexical", "entity"]);
		expect(out?.semantic).toBe(0.91);
		expect(out?.lexical).toBe(0.45);
		expect(out?.entity).toBe(0.85);
	});

	it("ignores non-channel list names (insights, knowledge)", () => {
		const m1 = makeResult({ type: "memory", id: "m1", similarity: 0.91 });
		const out = materializeSignals(
			[
				{ name: "memory-semantic", hits: [m1] },
				{ name: "insights", hits: [m1] },
				{ name: "knowledge", hits: [m1] },
			],
			m1,
		);
		// Only `semantic` is a real channel — insights / knowledge are skipped.
		expect(out?.channels).toEqual(["semantic"]);
		expect(out?.semantic).toBe(0.91);
	});

	it("takes the first occurrence of (type, id) per channel when the hit is duplicated in a list", () => {
		const m1First = makeResult({ type: "memory", id: "m1", similarity: 0.91 });
		const m1Second = makeResult({ type: "memory", id: "m1", similarity: 0.12 });
		const out = materializeSignals([{ name: "memory-semantic", hits: [m1First, m1Second] }], m1First);
		// First occurrence wins — the breakdown stays deterministic even when
		// the same `(type, id)` appears multiple times in a channel list.
		expect(out?.semantic).toBe(0.91);
	});

	it("copies rrfScore from metadata onto signals.rrf when present", () => {
		const m1 = makeResult({
			type: "memory",
			id: "m1",
			similarity: 0.91,
			metadata: { rrfScore: 0.0325 },
		});
		const out = materializeSignals([{ name: "memory-semantic", hits: [m1] }], m1);
		expect(out?.rrf).toBe(0.0325);
	});

	it("omits signals.rrf when metadata has no rrfScore", () => {
		const m1 = makeResult({ type: "memory", id: "m1", similarity: 0.91 });
		const out = materializeSignals([{ name: "memory-semantic", hits: [m1] }], m1);
		expect(out?.rrf).toBeUndefined();
	});

	it("does not duplicate a channel if the same name appears in multiple lists", () => {
		// Defensive: a caller could pass the same channel twice via different
		// aliases (e.g. "memory-bm25" + "memory-lexical"). Both map to the
		// same channel — only the first appearance should contribute.
		const m1 = makeResult({ type: "memory", id: "m1", similarity: 0.91 });
		const out = materializeSignals(
			[
				{ name: "memory-bm25", hits: [makeResult({ type: "memory", id: "m1", similarity: 0.5 })] },
				{ name: "memory-lexical", hits: [makeResult({ type: "memory", id: "m1", similarity: 0.2 })] },
			],
			m1,
		);
		expect(out?.channels).toEqual(["lexical"]);
		expect(out?.lexical).toBe(0.5);
	});
});
