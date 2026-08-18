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
import { createIterativeRecallPlanner } from "./iterative-recall";
import { type QueryRewriter, createUserVoiceRewriter } from "./query-rewriter";
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
			metadata: { channel: "general", timestamp: Date.parse("2024-05-15T00:00:00Z") },
		},
		{
			id: "m2",
			content: "beta",
			similarity: 0.7,
			metadata: { channel: "random", timestamp: Date.parse("2024-06-10T00:00:00Z") },
		},
	],
	searchRawMessagesLexical: async () => [
		{
			id: "m2",
			content: "beta",
			similarity: 0.5,
			metadata: { scoring: "bm25", timestamp: Date.parse("2024-06-10T00:00:00Z") },
		},
		{
			id: "m3",
			content: "gamma",
			similarity: 0.4,
			metadata: { scoring: "bm25", timestamp: Date.parse("2024-07-20T00:00:00Z") },
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

	it("uses rrf merge by default, and falls back to similarity when explicitly requested", async () => {
		const search = createUnifiedSearch(baseDeps);
		const out = await search.searchUnifiedMemory({ userId: "u1", query: "anything here" });
		// RRF is now the default merge strategy (see the memory-store changeset),
		// so every fused hit carries an rrfScore.
		expect(out.results.every((r) => typeof r.metadata.rrfScore === "number")).toBe(true);

		// Explicit similarity opt-out — equivalent to wiring
		// `deps.reasoning.defaultMergeStrategy = "similarity"`.
		const similarityOut = await search.searchUnifiedMemory({
			userId: "u1",
			query: "anything here",
			mergeStrategy: "similarity",
		});
		expect(similarityOut.results.every((r) => r.metadata.rrfScore === undefined)).toBe(true);
	});

	it("uses a query rewriter when reasoningStrategy='rewrite' is requested", async () => {
		const complete = vi.fn().mockResolvedValue("Did I tell you about alpha?");
		const rewriter = createUserVoiceRewriter({ complete });
		const embedQuery = vi.fn().mockResolvedValue(new Array(4).fill(0.1));
		const search = createUnifiedSearch({
			...baseDeps,
			embedQuery,
			reasoning: { queryRewriter: rewriter },
		});
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "what about alpha?",
			reasoningStrategy: "rewrite",
		});

		expect(out.reasoning?.strategy).toBe("rewrite");
		expect(out.reasoning?.rewrittenQueries).toEqual(["what about alpha?", "Did I tell you about alpha?"]);
		// The original query and the rewritten one should both have been embedded.
		expect(embedQuery).toHaveBeenCalledTimes(2);
	});

	it("falls back to default search when reasoningStrategy='rewrite' is requested but no rewriter is configured", async () => {
		const search = createUnifiedSearch(baseDeps);
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "anything here",
			reasoningStrategy: "rewrite",
		});

		expect(out.reasoning?.strategy).toBe("rewrite");
		expect(out.reasoning?.degraded).toBe(true);
		expect(out.results.length).toBeGreaterThan(0);
		expect(out.warnings.some((w) => w.code === "memory_query_rewrite_not_configured")).toBe(true);
	});

	it("uses an iterative planner when reasoningStrategy='iterative' is requested", async () => {
		const candidates = [{ id: "m1", content: "I adopted a cat named Luna.", similarity: 0.95, metadata: {} }];
		const replies = [
			'Thought: search for cat\nAction: search\nAction Input: {"keywords":["cat"]}',
			'Thought: note it\nAction: note\nAction Input: {"indices":[1]}',
			"Thought: finish\nAction: finish\nAction Input: {}",
		];
		const complete = vi.fn().mockImplementation(() => {
			const reply = replies.shift();
			return Promise.resolve(reply ?? "Thought: finish\nAction: finish\nAction Input: {}");
		});
		const planner = createIterativeRecallPlanner({ complete, options: { maxIterations: 3 } });
		const searchDeps: UnifiedSearchDeps = {
			...baseDeps,
			searchRawMessagesLexical: async () => candidates,
			reasoning: { iterativePlanner: planner },
		};
		const search = createUnifiedSearch(searchDeps);
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "what is my cat's name?",
			reasoningStrategy: "iterative",
		});

		expect(out.reasoning?.strategy).toBe("iterative");
		expect(out.reasoning?.evidenceCount).toBe(1);
		expect(out.results.some((r) => r.type === "memory" && r.id === "m1")).toBe(true);
	});

	it("runs semantic search inside iterative mode when embedQuery is available", async () => {
		const lexicalCandidates = [
			{ id: "m1", content: "I adopted a cat named Luna.", similarity: 0.95, metadata: {} },
		];
		const semanticCandidates = [
			{ id: "m2", content: "My cat Luna loves tuna.", similarity: 0.92, metadata: {} },
		];
		const embedQuery = vi.fn().mockResolvedValue(new Array(4).fill(0.1));
		const replies = [
			'Thought: search for cat\nAction: search\nAction Input: {"keywords":["cat"]}',
			'Thought: note both\nAction: note\nAction Input: {"indices":[1, 2]}',
			"Thought: finish\nAction: finish\nAction Input: {}",
		];
		const complete = vi.fn().mockImplementation(() => {
			const reply = replies.shift();
			return Promise.resolve(reply ?? "Thought: finish\nAction: finish\nAction Input: {}");
		});
		const planner = createIterativeRecallPlanner({ complete, options: { maxIterations: 3 } });
		const searchDeps: UnifiedSearchDeps = {
			...baseDeps,
			embedQuery,
			searchRawMessagesLexical: async () => lexicalCandidates,
			searchRawMessagesAnn: async () => semanticCandidates,
			reasoning: { iterativePlanner: planner },
		};
		const search = createUnifiedSearch(searchDeps);
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "what is my cat's name?",
			reasoningStrategy: "iterative",
		});

		expect(embedQuery).toHaveBeenCalled();
		expect(out.reasoning?.strategy).toBe("iterative");
		expect(out.results.some((r) => r.type === "memory" && r.id === "m1")).toBe(true);
		expect(out.results.some((r) => r.type === "memory" && r.id === "m2")).toBe(true);
	});

	it("filters memory results by dateFrom/dateTo", async () => {
		const search = createUnifiedSearch(baseDeps);
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "anything here",
			sources: ["memory"],
			dateFrom: "2024-06-01",
			dateTo: "2024-06-15",
		});

		const memoryIds = out.results.filter((r) => r.type === "memory").map((r) => r.id);
		expect(memoryIds).toContain("m2");
		expect(memoryIds).not.toContain("m1");
		expect(memoryIds).not.toContain("m3");
	});

	it("treats date-only boundaries as UTC inclusive days", async () => {
		const searchDeps: UnifiedSearchDeps = {
			...baseDeps,
			searchRawMessagesAnn: async () => [
				{
					id: "m1",
					content: "early",
					similarity: 0.9,
					metadata: { timestamp: Date.parse("2024-06-09T23:59:59Z") },
				},
				{
					id: "m2",
					content: "midnight",
					similarity: 0.9,
					metadata: { timestamp: Date.parse("2024-06-10T00:00:00Z") },
				},
				{
					id: "m3",
					content: "late",
					similarity: 0.9,
					metadata: { timestamp: Date.parse("2024-06-10T23:59:59Z") },
				},
				{
					id: "m4",
					content: "next",
					similarity: 0.9,
					metadata: { timestamp: Date.parse("2024-06-11T00:00:00Z") },
				},
			],
		};
		const search = createUnifiedSearch(searchDeps);
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "anything here",
			sources: ["memory"],
			dateFrom: "2024-06-10",
			dateTo: "2024-06-10",
		});

		const memoryIds = out.results.filter((r) => r.type === "memory").map((r) => r.id);
		expect(memoryIds).not.toContain("m1");
		expect(memoryIds).toContain("m2");
		expect(memoryIds).toContain("m3");
		expect(memoryIds).not.toContain("m4");
	});

	it("reports dateRange in reasoning for rewrite strategy", async () => {
		const complete = vi.fn().mockResolvedValue("Did I tell you about alpha?");
		const rewriter = createUserVoiceRewriter({ complete });
		const search = createUnifiedSearch({
			...baseDeps,
			embedQuery: async () => new Array(4).fill(0.1),
			reasoning: { queryRewriter: rewriter },
		});
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "what about alpha?",
			reasoningStrategy: "rewrite",
			dateFrom: "2024-01-01",
			dateTo: "2024-01-31",
		});

		expect(out.reasoning?.strategy).toBe("rewrite");
		expect(out.reasoning?.dateRange).toEqual({ from: "2024-01-01", to: "2024-01-31" });
	});

	it("passes dateFrom/dateTo to the iterative planner and reports the range in reasoning", async () => {
		const planner = {
			plan: vi.fn().mockResolvedValue({
				evidence: [],
				stats: { iterations: 0, searches: 0, notes: 0 },
			}),
		};
		const search = createUnifiedSearch({
			...baseDeps,
			reasoning: { iterativePlanner: planner },
		});
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "anything here",
			reasoningStrategy: "iterative",
			dateFrom: "2024-01-01",
			dateTo: "2024-01-31",
		});

		expect(planner.plan).toHaveBeenCalledWith(
			expect.objectContaining({
				query: "anything here",
				dateFrom: "2024-01-01",
				dateTo: "2024-01-31",
			}),
		);
		expect(out.reasoning?.dateRange).toEqual({ from: "2024-01-01", to: "2024-01-31" });
	});

	it("reports degraded when reasoningStrategy='iterative' has no planner configured", async () => {
		const search = createUnifiedSearch(baseDeps);
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "anything here",
			reasoningStrategy: "iterative",
		});

		expect(out.reasoning?.strategy).toBe("iterative");
		expect(out.reasoning?.degraded).toBe(true);
		expect(out.warnings.some((w) => w.code === "memory_iterative_planner_not_configured")).toBe(true);
	});
	it("reports degraded when the iterative planner self-reports lastDegraded", async () => {
		const planner = createIterativeRecallPlanner({
			complete: vi.fn().mockResolvedValue("not a valid action"),
		});
		const search = createUnifiedSearch({
			...baseDeps,
			reasoning: { iterativePlanner: planner },
		});
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "anything here",
			reasoningStrategy: "iterative",
		});

		expect(out.reasoning?.strategy).toBe("iterative");
		expect(out.reasoning?.degraded).toBe(true);
	});

	it("does not mark degraded when the iterative planner commits evidence", async () => {
		const candidates = [{ id: "m1", content: "I adopted a cat named Luna.", similarity: 0.95, metadata: {} }];
		const replies = [
			'Thought: search\nAction: search\nAction Input: {"keywords":["cat"]}',
			'Thought: note\nAction: note\nAction Input: {"indices":[1]}',
			"Thought: done\nAction: finish\nAction Input: {}",
		];
		const complete = vi.fn().mockImplementation(() => {
			const reply = replies.shift();
			return Promise.resolve(reply ?? "Thought: done\nAction: finish\nAction Input: {}");
		});
		const planner = createIterativeRecallPlanner({ complete });
		const search = createUnifiedSearch({
			...baseDeps,
			searchRawMessagesLexical: async () => candidates,
			reasoning: { iterativePlanner: planner },
		});
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "what is my cat's name?",
			reasoningStrategy: "iterative",
		});

		expect(out.reasoning?.degraded).toBeUndefined();
	});

	it("reports degraded when the query rewriter LLM call throws", async () => {
		const rewriter: QueryRewriter = {
			rewrite: vi.fn().mockRejectedValue(new Error("upstream down")),
		};
		const search = createUnifiedSearch({
			...baseDeps,
			embedQuery: async () => new Array(4).fill(0.1),
			reasoning: { queryRewriter: rewriter },
		});
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "what about alpha?",
			reasoningStrategy: "rewrite",
		});

		expect(out.reasoning?.degraded).toBe(true);
		expect(out.warnings.some((w) => w.code === "memory_query_rewrite_failed")).toBe(true);
	});

	it("emits reasoning.dateRange even when strategy is 'none'", async () => {
		const search = createUnifiedSearch(baseDeps);
		const out = await search.searchUnifiedMemory({
			userId: "u1",
			query: "anything here",
			sources: ["memory"],
			dateFrom: "2024-06-01",
			dateTo: "2024-06-15",
		});

		expect(out.reasoning).toBeDefined();
		expect(out.reasoning?.strategy).toBe("none");
		expect(out.reasoning?.dateRange).toEqual({ from: "2024-06-01", to: "2024-06-15" });
		expect(out.reasoning?.degraded).toBeUndefined();
	});
});
