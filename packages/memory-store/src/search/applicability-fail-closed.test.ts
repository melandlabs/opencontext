import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UnifiedSearchDeps } from "../config";
import type { SearchRuntimeContext } from "./applicability";
import { createUnifiedSearch } from "./unified-search";

const builtIns = vi.hoisted(() => ({
	chromaEnabled: false,
	searchChroma: vi.fn(),
	getRawMessageManager: vi.fn(),
	searchSqliteSemantic: vi.fn(),
	searchSqliteLexical: vi.fn(),
}));

vi.mock("../storage/chroma-memory-index", () => ({
	isRawMessageChromaEnabled: () => builtIns.chromaEnabled,
	searchRawMessagesWithChroma: builtIns.searchChroma,
}));

vi.mock("../storage/raw-message-store", () => ({
	isRawMessageStorageAvailable: () => true,
	getRawMessageManager: builtIns.getRawMessageManager,
}));

vi.mock("../storage/sqlite-raw-message-store", () => ({
	lexicalSearchRawMessages: builtIns.searchSqliteLexical,
}));

const builtInHit = {
	id: "legacy-raw",
	content: "legacy unscoped raw memory",
	similarity: 0.95,
	metadata: {},
};

beforeEach(() => {
	vi.clearAllMocks();
	builtIns.chromaEnabled = false;
	builtIns.searchChroma.mockResolvedValue([builtInHit]);
	builtIns.searchSqliteSemantic.mockResolvedValue([builtInHit]);
	builtIns.searchSqliteLexical.mockResolvedValue([builtInHit]);
	builtIns.getRawMessageManager.mockResolvedValue({
		searchMessagesSemantically: builtIns.searchSqliteSemantic,
	});
});

function searchRaw(deps: UnifiedSearchDeps, runtimeContext?: SearchRuntimeContext) {
	return createUnifiedSearch(deps).search(
		{
			userId: "u1",
			query: "Alpha project details",
			tiers: ["raw"],
			sources: ["memory"],
		},
		runtimeContext,
	);
}

function expectApplicabilityWarning(warnings: ReadonlyArray<{ code: string }>): void {
	expect(warnings.filter((warning) => warning.code === "memory_applicability_not_enforced")).toHaveLength(1);
}

describe("built-in raw-message applicability fail-closed behaviour", () => {
	it("does not query Chroma for a scoped search", async () => {
		builtIns.chromaEnabled = true;

		const output = await searchRaw({ embedQuery: async () => [0.1, 0.2] }, { applicabilityContexts: [] });

		expect(output.results).toEqual([]);
		expect(builtIns.searchChroma).not.toHaveBeenCalled();
		expect(builtIns.getRawMessageManager).not.toHaveBeenCalled();
		expectApplicabilityWarning(output.warnings);
	});

	it("does not query the built-in SQLite semantic source for a scoped search", async () => {
		const output = await searchRaw(
			{ embedQuery: async () => [0.1, 0.2] },
			{ applicabilityContexts: [{ scope: "project", key: "project-a" }] },
		);

		expect(output.results).toEqual([]);
		expect(builtIns.getRawMessageManager).not.toHaveBeenCalled();
		expect(builtIns.searchSqliteSemantic).not.toHaveBeenCalled();
		expectApplicabilityWarning(output.warnings);
	});

	it("does not query the built-in SQLite lexical source for a scoped search", async () => {
		const output = await searchRaw({}, { applicabilityContexts: [{ scope: "project", key: "project-a" }] });

		expect(output.results).toEqual([]);
		expect(builtIns.searchSqliteLexical).not.toHaveBeenCalled();
		expectApplicabilityWarning(output.warnings);
	});

	it("does not fall back to SQLite when an applicability-aware lexical provider fails", async () => {
		const output = await searchRaw(
			{
				searchRawMessagesLexical: async () => {
					throw new Error("provider unavailable");
				},
				logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
			},
			{ applicabilityContexts: [{ scope: "project", key: "project-a" }] },
		);

		expect(output.results).toEqual([]);
		expect(builtIns.searchSqliteLexical).not.toHaveBeenCalled();
		expectApplicabilityWarning(output.warnings);
	});

	it("uses an applicability-aware ANN provider instead of enabled Chroma", async () => {
		builtIns.chromaEnabled = true;
		const searchRawMessagesAnn = vi.fn<NonNullable<UnifiedSearchDeps["searchRawMessagesAnn"]>>(async () => [
			{ id: "scoped", content: "project A", similarity: 0.9, metadata: {} },
		]);

		const output = await searchRaw(
			{ embedQuery: async () => [0.1, 0.2], searchRawMessagesAnn },
			{ applicabilityContexts: [{ scope: "project", key: "project-a" }] },
		);

		expect(output.results.map((result) => result.id)).toEqual(["scoped"]);
		expect(searchRawMessagesAnn).toHaveBeenCalledTimes(1);
		expect(builtIns.searchChroma).not.toHaveBeenCalled();
		expect(output.warnings).not.toContainEqual(
			expect.objectContaining({ code: "memory_applicability_not_enforced" }),
		);
	});

	it("does not fall back to SQLite when an applicability-aware ANN provider returns no hits", async () => {
		const output = await searchRaw(
			{
				embedQuery: async () => [0.1, 0.2],
				searchRawMessagesAnn: async () => [],
			},
			{ applicabilityContexts: [{ scope: "project", key: "project-a" }] },
		);

		expect(output.results).toEqual([]);
		expect(builtIns.getRawMessageManager).not.toHaveBeenCalled();
		expectApplicabilityWarning(output.warnings);
	});

	it("preserves legacy Chroma retrieval when no runtime context is supplied", async () => {
		builtIns.chromaEnabled = true;

		const output = await searchRaw({ embedQuery: async () => [0.1, 0.2] });

		expect(output.results.map((result) => result.id)).toContain("legacy-raw");
		expect(builtIns.searchChroma).toHaveBeenCalledTimes(1);
		expect(output.warnings).not.toContainEqual(
			expect.objectContaining({ code: "memory_applicability_not_enforced" }),
		);
	});

	it("preserves legacy SQLite semantic and lexical fallbacks", async () => {
		const semanticOutput = await searchRaw({ embedQuery: async () => [0.1, 0.2] });
		const lexicalOutput = await searchRaw({});

		expect(semanticOutput.results.map((result) => result.id)).toContain("legacy-raw");
		expect(lexicalOutput.results.map((result) => result.id)).toContain("legacy-raw");
		expect(builtIns.searchSqliteSemantic).toHaveBeenCalledTimes(1);
		expect(builtIns.searchSqliteLexical).toHaveBeenCalledTimes(1);
	});
});
