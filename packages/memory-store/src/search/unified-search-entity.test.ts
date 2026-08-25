/**
 * Regression tests for the entity-channel merge-strategy behaviour:
 *   - under `mergeStrategy: "similarity"` standalone entity hits are
 *     suppressed (entity scores live on a different scale than cosine/BM25
 *     and would otherwise shadow real message content) and a
 *     `memory_entity_requires_rrf` warning is emitted.
 *   - under `mergeStrategy: "rrf"` entity hits are surfaced (rank fusion
 *     keeps the real message content via the shared `(type, id)` key).
 */
import { describe, expect, it } from "vitest";

import type { UnifiedSearchDeps } from "../config";
import { createUnifiedSearch } from "./unified-search";

// `runMemorySource` only executes when a raw provider is wired
// (`hasRawProviders`), so we stub a no-op lexical provider to keep the
// memory source alive; the entity sub-query runs independently of it.
const deps: UnifiedSearchDeps = {
	entitySearch: async ({ keywords }) => {
		if (keywords.includes("luna")) {
			return [{ messageId: "m-luna", label: "Luna", score: 0.95 }];
		}
		return [];
	},
	// Stubs so the semantic/lexical sub-queries succeed (returning nothing)
	// instead of throwing on a missing embedder, which would abort
	// `runMemorySource` before the entity sub-query runs.
	embedQuery: async () => new Array(16).fill(0),
	searchRawMessagesAnn: async () => [],
	searchRawMessagesLexical: async () => [],
};

describe("entity channel merge strategy", () => {
	it("suppresses standalone entity hits under similarity merge and warns", async () => {
		const search = createUnifiedSearch(deps);
		const out = await search.search({
			userId: "u1",
			query: "Luna",
			mergeStrategy: "similarity",
		});
		expect(out.warnings.some((w) => w.code === "memory_entity_requires_rrf")).toBe(true);
		expect(out.results).toEqual([]);
	});

	it("surfaces entity hits under rrf merge without the warning", async () => {
		const search = createUnifiedSearch(deps);
		const out = await search.search({
			userId: "u1",
			query: "Luna",
			mergeStrategy: "rrf",
		});
		expect(out.warnings.some((w) => w.code === "memory_entity_requires_rrf")).toBe(false);
		expect(out.results).toHaveLength(1);
		expect(out.results[0]?.id).toBe("m-luna");
		expect(out.results[0]?.metadata.isEntityProjection).toBe(true);
	});
});
