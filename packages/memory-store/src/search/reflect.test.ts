/**
 * Tests for the single-turn `reflect()` synthesis path.
 *
 * Covers:
 *   - evidence gathering across all four tiers (summary, raw, insight, knowledge)
 *   - prompt construction (sections grouped by tier)
 *   - schema-aware response handling (extract JSON, fall back to text)
 *   - LLM failure degradation (no throw, evidence preserved, warning added)
 *   - missing `complete` warning
 *   - missing tier providers (e.g. no `searchSummaries`)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedSearchDeps } from "../config";
import { createUnifiedSearch } from "./unified-search";

vi.mock("../storage/chroma-memory-index", () => ({
	isRawMessageChromaEnabled: () => false,
	searchRawMessagesWithChroma: () => Promise.resolve([]),
}));

vi.mock("../storage/raw-message-store", () => ({
	isRawMessageStorageAvailable: () => false,
}));

const baseDeps: UnifiedSearchDeps = {
	embedQuery: async () => new Array(4).fill(0.1),
	searchRawMessagesAnn: async () => [
		{ id: "m1", content: "raw message about cats", similarity: 0.95, metadata: {} },
	],
	searchRawMessagesLexical: async () => [
		{ id: "m2", content: "another raw mention of cats", similarity: 0.5, metadata: { scoring: "bm25" } },
	],
	searchInsights: async () => [{ id: "i1", content: "insight about cats", similarity: 0.8, metadata: {} }],
	searchKnowledge: async () => [
		{
			chunkId: "k1",
			documentId: "d1",
			documentName: "doc",
			content: "knowledge chunk on cats",
			similarity: 0.6,
			chunkIndex: 0,
		},
	],
	searchSummaries: async () => [
		{
			summaryId: "s1",
			summaryText: "summary about cats",
			summaryTier: "L1",
			keywords: ["cats"],
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("reflect()", () => {
	it("returns the LLM answer plus evidence from every tier", async () => {
		const complete = vi.fn().mockResolvedValue("Cats are great.");
		const search = createUnifiedSearch({
			...baseDeps,
			reasoning: { complete },
		});
		const out = await search.reflect({ userId: "u1", query: "cats" });
		expect(out.answer).toBe("Cats are great.");
		// 4 sources, plus deduped raw hits — at least one per tier should be present.
		const sources = new Set(out.evidence.map((item) => item.source));
		expect(sources.has("summary")).toBe(true);
		expect(sources.has("raw")).toBe(true);
		expect(sources.has("insight")).toBe(true);
		expect(sources.has("knowledge")).toBe(true);
	});

	it("extracts the answer from a JSON response when responseSchema is supplied", async () => {
		const complete = vi
			.fn()
			.mockResolvedValue('Here you go:\n```json\n{"answer":"Cats are great.","confidence":0.9}\n```');
		const search = createUnifiedSearch({
			...baseDeps,
			reasoning: { complete },
		});
		const out = await search.reflect({
			userId: "u1",
			query: "cats",
			responseSchema: { answer: "string" },
		});
		expect(out.answer).toBe("Cats are great.");
	});

	it("falls back to the raw text when the JSON parse fails", async () => {
		const complete = vi.fn().mockResolvedValue("not really JSON");
		const search = createUnifiedSearch({
			...baseDeps,
			reasoning: { complete },
		});
		const out = await search.reflect({
			userId: "u1",
			query: "cats",
			responseSchema: { answer: "string" },
		});
		expect(out.answer).toBe("not really JSON");
	});

	it("degrades gracefully when the LLM throws: evidence preserved, warning added", async () => {
		const complete = vi.fn().mockRejectedValue(new Error("upstream down"));
		const search = createUnifiedSearch({
			...baseDeps,
			reasoning: { complete },
		});
		const out = await search.reflect({ userId: "u1", query: "cats" });
		expect(out.answer).toBe("");
		expect(out.evidence.length).toBeGreaterThan(0);
		expect(out.warnings.some((w) => w.code === "reflect_llm_failed")).toBe(true);
	});

	it("emits reflect_llm_not_configured when no complete callback is wired", async () => {
		const search = createUnifiedSearch(baseDeps);
		const out = await search.reflect({ userId: "u1", query: "cats" });
		expect(out.answer).toBe("");
		expect(out.evidence.length).toBeGreaterThan(0);
		expect(out.warnings.some((w) => w.code === "reflect_llm_not_configured")).toBe(true);
	});

	it("skips a tier when its provider is absent", async () => {
		const { searchSummaries: _ignore, ...depsWithoutSummaries } = baseDeps;
		const complete = vi.fn().mockResolvedValue("ok");
		const search = createUnifiedSearch({
			...depsWithoutSummaries,
			reasoning: { complete },
		});
		const out = await search.reflect({ userId: "u1", query: "cats" });
		expect(out.evidence.every((item) => item.source !== "summary")).toBe(true);
		expect(out.warnings.some((w) => w.code === "reflect_summaries_unavailable")).toBe(true);
	});

	it("respects tiers filter", async () => {
		const complete = vi.fn().mockResolvedValue("ok");
		const search = createUnifiedSearch({
			...baseDeps,
			reasoning: { complete },
		});
		const out = await search.reflect({
			userId: "u1",
			query: "cats",
			tiers: ["summary"],
		});
		const sources = new Set(out.evidence.map((item) => item.source));
		expect(sources.has("summary")).toBe(true);
		expect(sources.has("raw")).toBe(false);
		expect(sources.has("insight")).toBe(false);
		expect(sources.has("knowledge")).toBe(false);
	});

	it("returns empty results for an empty query", async () => {
		const complete = vi.fn();
		const search = createUnifiedSearch({
			...baseDeps,
			reasoning: { complete },
		});
		const out = await search.reflect({ userId: "u1", query: "   " });
		expect(out.answer).toBe("");
		expect(out.evidence).toEqual([]);
		expect(complete).not.toHaveBeenCalled();
	});
});
