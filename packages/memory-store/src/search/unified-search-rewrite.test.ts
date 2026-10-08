import { describe, expect, it, vi } from "vitest";
import type { UnifiedSearchDeps } from "../config";
import { createUnifiedSearch, deriveLexicalKeywords } from "./unified-search";

const { storageFallback } = vi.hoisted(() => ({ storageFallback: vi.fn(async () => []) }));
vi.mock("../storage/sqlite-raw-message-store", () => ({ lexicalSearchRawMessages: storageFallback }));

const hit = (id: string, similarity = 0.5, content = id, metadata = {}) => ({
	id,
	content,
	similarity,
	metadata,
});
const query = "original topic";
function setup(variants = [query, "new topic"], enabled = true) {
	const lexical = vi.fn<NonNullable<UnifiedSearchDeps["searchRawMessagesLexical"]>>(async () => []);
	const deps: UnifiedSearchDeps = {
		embedQuery: async () => [1],
		searchRawMessagesAnn: async () => [hit("semantic")],
		searchRawMessagesLexical: lexical,
		reasoning: { queryRewriter: { rewrite: async () => variants }, rewriteLexical: enabled },
	};
	const search = (extra = {}) =>
		createUnifiedSearch(deps).search({
			userId: "u1",
			query,
			sources: ["memory"],
			reasoningStrategy: "rewrite",
			mergeStrategy: "rrf",
			limit: 12,
			includeRetrievalDiagnostics: true,
			...extra,
		});
	return { deps, lexical, search };
}

describe("opt-in lexical query rewriting", () => {
	it("does not activate a hidden store when the lexical host dependency is absent", async () => {
		const { deps, search } = setup();
		Reflect.deleteProperty(deps, "searchRawMessagesLexical");
		const output = await search();
		expect(output.reasoning?.lexicalRewrittenQueries).toBeUndefined();
		expect(output.warnings?.some((row) => row.code === "memory_lexical_search_not_configured")).toBe(true);
		expect(storageFallback).not.toHaveBeenCalled();
	});
	it("retains a healthy variant after a provider failure without switching stores", async () => {
		const { lexical, search } = setup();
		lexical.mockImplementation(async ({ keywords }) => {
			if (keywords.includes("original")) throw new Error("host failed");
			return [hit("valid")];
		});
		const output = await search();
		expect(output.retrievalDiagnostics?.channels.lexical.map((row) => row.id)).toEqual(["valid"]);
		expect(output.warnings?.some((row) => row.code === "memory_lexical_search_failed")).toBe(true);
		expect(storageFallback).not.toHaveBeenCalled();
	});
	it("keeps the original-only lexical path when disabled", async () => {
		const { lexical, search } = setup(undefined, false);
		const output = await search();
		expect(lexical).toHaveBeenCalledTimes(1);
		expect(lexical.mock.calls[0][0].keywords).toEqual(deriveLexicalKeywords(query));
		expect(output.reasoning?.lexicalRewrittenQueries).toBeUndefined();
	});
	it("keeps the original query, deduplicates and bounds lexical variants", async () => {
		const { lexical, search } = setup([
			" ORIGINAL TOPIC ",
			"new topic",
			"NEW TOPIC",
			"",
			"third topic",
			"fourth topic",
			"fifth topic",
		]);
		const output = await search();
		expect(lexical).toHaveBeenCalledTimes(4);
		expect(output.reasoning?.lexicalRewrittenQueries).toEqual([
			query,
			"new topic",
			"third topic",
			"fourth topic",
		]);
	});
	it("folds incomparable BM25 scales by rank without losing that order to parent dedupe", async () => {
		const { lexical, search } = setup();
		lexical.mockImplementation(async ({ keywords }) =>
			keywords.includes("original")
				? [hit("huge", 1000), hit("shared", 1)]
				: [hit("other", 0.9), hit("shared", 0.1)],
		);
		const output = await search();
		const channel = output.retrievalDiagnostics?.channels.lexical;
		expect(channel?.[0].id).toBe("shared");
		expect(channel?.[0].similarity).toBeCloseTo(2 / 62);
		expect(channel?.[0].metadata.scoring).toBe("bm25");
	});
	it("counts a parent once per query while retaining different matched spans", async () => {
		const { lexical, search } = setup();
		lexical.mockImplementation(async ({ keywords }) =>
			keywords.includes("original")
				? [
						hit("c1", 0.9, "first evidence", { sourceMessageId: "parent", sourceChunkId: "c1" }),
						hit("c2", 0.8, "second evidence", { sourceMessageId: "parent", sourceChunkId: "c2" }),
					]
				: [hit("parent", 0.5, "third evidence", { sourceChunkId: "c3" })],
		);
		const output = await search();
		const channel = output.retrievalDiagnostics?.channels.lexical;
		expect(channel).toHaveLength(1);
		expect(channel?.[0].similarity).toBeCloseTo(2 / 61);
		expect(channel?.[0].metadata.matchedSpans).toHaveLength(3);
		const parent = output.results.find((row) => row.id === "parent");
		for (const text of ["first evidence", "second evidence", "third evidence"])
			expect(parent?.content).toContain(text);
	});
	it("preserves bot, historical and lifecycle filters and applies date bounds", async () => {
		const { lexical, search } = setup();
		lexical.mockResolvedValue([
			hit("old", 0.9, "old", { timestamp: Date.parse("2023-01-01") }),
			hit("current", 0.8, "current", { timestamp: Date.parse("2024-02-01") }),
		]);
		const output = await search({
			botIds: ["bot1", "bot2"],
			asOf: 1234,
			includeDeprecated: true,
			dateFrom: "2024-01-01",
			dateTo: "2024-12-31",
		});
		expect(lexical).toHaveBeenCalledTimes(4);
		for (const [request] of lexical.mock.calls) {
			expect(request).toMatchObject({ userId: "u1", asOf: 1234, includeDeprecated: true, limit: 24 });
			expect(["bot1", "bot2"]).toContain(request.botId);
		}
		expect(output.retrievalDiagnostics?.channels.lexical.map((row) => row.id)).toEqual(["current"]);
	});
	it("retains the original-only path after rewriter failure or with similarity merging", async () => {
		const { deps, lexical, search } = setup();
		await search({ mergeStrategy: "similarity" });
		expect(lexical).toHaveBeenCalledTimes(1);
		lexical.mockClear();
		if (deps.reasoning?.queryRewriter)
			deps.reasoning.queryRewriter.rewrite = async () => {
				throw new Error("transport failure");
			};
		const output = await search();
		expect(lexical).toHaveBeenCalledTimes(1);
		expect(output.reasoning?.degraded).toBe(true);
		expect(output.reasoning?.lexicalRewrittenQueries).toBeUndefined();
	});
});

describe("opt-in semantic variant rank fusion", () => {
	function semanticSetup(variants = [query, "new topic"]) {
		const fixture = setup(variants, false);
		const embed = vi.fn(async ({ query: text }: { query: string }) => [text === query ? 1 : 2]);
		const ann = vi.fn<NonNullable<UnifiedSearchDeps["searchRawMessagesAnn"]>>(async ({ queryEmbedding }) =>
			queryEmbedding[0] === 1
				? [hit("dominant", 0.99), hit("shared", 0.9)]
				: [hit("other", 0.4), hit("shared", 0.3)],
		);
		fixture.deps.embedQuery = embed;
		fixture.deps.searchRawMessagesAnn = ann;
		return { ...fixture, embed, ann };
	}
	it("keeps max-score merging by default and preserves rank fusion through parent dedupe", async () => {
		const { deps, search, embed, ann, lexical } = semanticSetup();
		const original = await search();
		expect(original.retrievalDiagnostics?.channels.semantic[0].id).toBe("dominant");
		expect(original.reasoning?.semanticVariantMerge).toBeUndefined();
		if (deps.reasoning) deps.reasoning.rewriteSemanticMerge = "rrf";
		embed.mockClear();
		ann.mockClear();
		lexical.mockClear();
		const changed = await search();
		expect(changed.retrievalDiagnostics?.channels.semantic[0].id).toBe("shared");
		expect(changed.retrievalDiagnostics?.channels.semantic[0].similarity).toBeCloseTo(2 / 62);
		expect(changed.reasoning?.semanticVariantMerge).toBe("rrf");
		expect(embed.mock.calls.map(([request]) => request.query)).toEqual([query, "new topic"]);
		expect(ann).toHaveBeenCalledTimes(2);
		expect(lexical).toHaveBeenCalledTimes(1);
	});
	it("counts a parent once per variant while retaining its distinct evidence spans", async () => {
		const { deps, search, ann } = semanticSetup();
		if (deps.reasoning) deps.reasoning.rewriteSemanticMerge = "rrf";
		ann.mockImplementation(async ({ queryEmbedding }) =>
			queryEmbedding[0] === 1
				? [
						hit("c1", 0.9, "first evidence", { sourceMessageId: "parent", sourceChunkId: "c1" }),
						hit("c2", 0.8, "second evidence", { sourceMessageId: "parent", sourceChunkId: "c2" }),
					]
				: [hit("parent", 0.5, "third evidence", { sourceChunkId: "c3" })],
		);
		const result = await search();
		const channel = result.retrievalDiagnostics?.channels.semantic;
		expect(channel).toHaveLength(1);
		expect(channel?.[0].similarity).toBeCloseTo(2 / 61);
		expect(channel?.[0].metadata.matchedSpans).toHaveLength(3);
		for (const text of ["first evidence", "second evidence", "third evidence"])
			expect(result.results[0].content).toContain(text);
	});
	it("preserves the native candidate budget, scope, lifecycle and date filters", async () => {
		const { deps, search, ann } = semanticSetup();
		if (deps.reasoning) deps.reasoning.rewriteSemanticMerge = "rrf";
		ann.mockResolvedValue([
			hit("old", 0.9, "old", { timestamp: Date.parse("2023-01-01") }),
			hit("current", 0.8, "current", { timestamp: Date.parse("2024-02-01") }),
		]);
		const result = await search({
			botIds: ["b1", "b2"],
			asOf: 1234,
			includeDeprecated: true,
			dateFrom: "2024-01-01",
			dateTo: "2024-12-31",
		});
		expect(ann).toHaveBeenCalledTimes(4);
		for (const [request] of ann.mock.calls) {
			expect(request).toMatchObject({ userId: "u1", limit: 48, asOf: 1234, includeDeprecated: true });
			expect(["b1", "b2"]).toContain(request.botId);
		}
		expect(result.retrievalDiagnostics?.channels.semantic.map((row) => row.id)).toEqual(["current"]);
	});
	it("does not change single-query, similarity merging or failed rewriter behavior", async () => {
		const { deps, search } = semanticSetup([query]);
		if (deps.reasoning) deps.reasoning.rewriteSemanticMerge = "rrf";
		const single = await search();
		expect(single.reasoning?.semanticVariantMerge).toBeUndefined();
		expect(single.retrievalDiagnostics?.channels.semantic[0].similarity).toBe(0.99);
		if (deps.reasoning?.queryRewriter)
			deps.reasoning.queryRewriter.rewrite = async () => [query, "new topic"];
		expect((await search({ mergeStrategy: "similarity" })).reasoning?.semanticVariantMerge).toBeUndefined();
		if (deps.reasoning?.queryRewriter)
			deps.reasoning.queryRewriter.rewrite = async () => {
				throw new Error("failed");
			};
		const failed = await search();
		expect(failed.reasoning?.degraded).toBe(true);
		expect(failed.reasoning?.semanticVariantMerge).toBeUndefined();
		expect(failed.retrievalDiagnostics?.channels.semantic[0].similarity).toBe(0.99);
	});
	it("does not claim variant rank fusion when every variant is empty", async () => {
		const { deps, search, ann } = semanticSetup();
		if (deps.reasoning) deps.reasoning.rewriteSemanticMerge = "rrf";
		ann.mockResolvedValue([]);
		const empty = await search();
		expect(empty.reasoning?.semanticVariantMerge).toBeUndefined();
		expect(empty.results).toEqual([]);
	});
});
