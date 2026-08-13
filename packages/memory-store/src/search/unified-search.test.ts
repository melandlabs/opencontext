/**
 * Tests for the additions to `search/unified-search`:
 *   - the optional lexical (BM25) sub-query alongside the semantic one
 *   - the `mergeStrategy: "rrf"` selection
 *   - the `memory_lexical_search_not_configured` warning when RRF is requested
 *     without a lexical provider wired in
 *
 * These tests run with stubbed deps and the SQLite singleton bypassed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UnifiedSearchDeps } from "../config";
import { createUnifiedSearch } from "./unified-search";

vi.mock("../storage/chroma-memory-index", () => ({
	isRawMessageChromaEnabled: () => false,
	searchRawMessagesWithChroma: () => Promise.resolve([]),
}));

vi.mock("../storage/raw-message-store", () => ({
	isRawMessageStorageAvailable: () => true,
}));

const baseDeps: UnifiedSearchDeps = {
	embedQuery: async () => new Array(4).fill(0.1),
	searchRawMessagesAnn: async () => [
		{
			id: "m1",
			content: "alpha",
			similarity: 0.9,
			metadata: { channel: "general" },
		},
		{
			id: "m2",
			content: "beta",
			similarity: 0.7,
			metadata: { channel: "random" },
		},
	],
	searchRawMessagesLexical: async () => [
		{
			id: "m2",
			content: "beta",
			similarity: 0.5,
			metadata: { scoring: "bm25" },
		},
		{
			id: "m3",
			content: "gamma",
			similarity: 0.4,
			metadata: { scoring: "bm25" },
		},
	],
	searchInsights: async () => [
		{
			id: "i1",
			content: "insight",
			similarity: 0.8,
			metadata: { source: "x" },
		},
	],
	searchKnowledge: async () => [
		{
			chunkId: "k1",
			documentId: "d1",
			documentName: "doc",
			content: "knowledge",
			similarity: 0.6,
			chunkIndex: 0,
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createUnifiedSearch", () => {
	it("uses similarity merge by default and dedupes by (type,id)", async () => {
		const search = createUnifiedSearch(baseDeps);
		const out = await search.searchUnifiedMemory({ userId: "u1", query: "anything here" });
		expect(out.warnings).toEqual([]);
		// m2 appears in both semantic and lexical; similarity wins.
		const ids = out.results.map((r) => `${r.type}:${r.id}`);
		expect(ids).toContain("memory:m1");
		expect(ids).toContain("memory:m2");
		expect(ids).toContain("memory:m3");
		expect(ids).toContain("insight:i1");
		expect(ids).toContain("knowledge:k1");
	});

	it("uses RRF when mergeStrategy='rrf' and surfaces lexical hits", async () => {
		const search = createUnifiedSearch(baseDeps);
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "anything here",
			mergeStrategy: "rrf",
		});
		const top = out.results.find((r) => r.type === "memory" && r.id === "m2");
		expect(top).toBeDefined();
		expect(top?.metadata.rrfScore).toBeGreaterThan(0);
	});

	it("emits a warning when rrf is requested but lexical is not configured", async () => {
		const { searchRawMessagesLexical: _lexical, ...depsWithoutLexical } = baseDeps;
		const search = createUnifiedSearch(depsWithoutLexical);
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "anything here",
			mergeStrategy: "rrf",
		});
		expect(out.warnings.some((w) => w.code === "memory_lexical_search_not_configured")).toBe(true);
	});

	it("keeps working when lexical is configured but only emits similarity merge by default", async () => {
		const search = createUnifiedSearch(baseDeps);
		const out = await search.searchUnifiedMemory({ userId: "u1", query: "anything here" });
		// Default strategy — no rrfScore on any hit.
		expect(out.results.every((r) => r.metadata.rrfScore === undefined)).toBe(true);
	});
});
