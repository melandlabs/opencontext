import type { MemoryApplicabilityContext } from "@melandlabs/memory-consolidation";
import { applicabilityMatchesTrustedContexts } from "@melandlabs/memory-consolidation/graph-retrieval";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UnifiedSearchDeps, UnifiedSearchKnowledgeResult, UnifiedSearchReasoningDeps } from "../config";
import type { IterativeRecallPlanner, IterativeRecallSearchRequest } from "./iterative-recall";
import { createUnifiedSearch } from "./unified-search";

vi.mock("../storage/chroma-memory-index", () => ({
	isRawMessageChromaEnabled: () => false,
	searchRawMessagesWithChroma: () => Promise.resolve([]),
}));

vi.mock("../storage/raw-message-store", () => ({
	isRawMessageStorageAvailable: () => true,
}));

type ProviderName = "ann" | "lexical" | "entity" | "knowledge" | "insights" | "summaries";
type ProviderCalls = Record<ProviderName, unknown[]>;

function createProviderCalls(): ProviderCalls {
	return {
		ann: [],
		lexical: [],
		entity: [],
		knowledge: [],
		insights: [],
		summaries: [],
	};
}

function createRecordingDeps(
	calls: ProviderCalls,
	reasoning?: UnifiedSearchReasoningDeps,
): UnifiedSearchDeps {
	return {
		embedQuery: async () => [0.1, 0.2],
		searchRawMessagesAnn: async (input) => {
			calls.ann.push(input);
			return [{ id: "raw-ann", content: "ann", similarity: 0.9, metadata: {} }];
		},
		searchRawMessagesLexical: async (input) => {
			calls.lexical.push(input);
			return [{ id: "raw-lexical", content: "lexical", similarity: 0.8, metadata: {} }];
		},
		entitySearch: async (input) => {
			calls.entity.push(input);
			return [{ messageId: "raw-entity", label: "Alpha", score: 0.7 }];
		},
		searchKnowledge: async (input) => {
			calls.knowledge.push(input);
			return [
				{
					chunkId: "chunk-1",
					documentId: "doc-1",
					documentName: "Doc",
					content: "knowledge",
					similarity: 0.6,
					chunkIndex: 0,
				},
			];
		},
		searchInsights: async (input) => {
			calls.insights.push(input);
			return [{ id: "insight-1", content: "insight", similarity: 0.5, metadata: {} }];
		},
		searchSummaries: async (input) => {
			calls.summaries.push(input);
			return [{ summaryId: "summary-1", summaryText: "summary" }];
		},
		reasoning,
	};
}

function allProviderInputs(calls: ProviderCalls): Array<Record<string, unknown>> {
	return Object.values(calls).flat() as Array<Record<string, unknown>>;
}

function expectRuntimeOnEveryCall(
	calls: ProviderCalls,
	contexts: readonly MemoryApplicabilityContext[],
	applicabilityAt: number,
): void {
	const inputs = allProviderInputs(calls);
	expect(inputs.length).toBeGreaterThan(0);
	for (const input of inputs) {
		expect(input.applicabilityContexts).toBe(contexts);
		expect(input.applicabilityAt).toBe(applicabilityAt);
	}
}

async function searchEveryTier(
	deps: UnifiedSearchDeps,
	runtimeContext?: { applicabilityContexts: readonly MemoryApplicabilityContext[] },
	asOf?: string,
): Promise<void> {
	await createUnifiedSearch(deps).search(
		{
			userId: "u1",
			query: "Alpha project details",
			tiers: ["summary", "raw", "insight", "knowledge"],
			sources: ["memory", "insights", "knowledge"],
			asOf,
		},
		runtimeContext,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("search applicability propagation", () => {
	it("forwards the same contexts and parsed asOf to all six retrieval providers", async () => {
		const calls = createProviderCalls();
		const contexts = [{ scope: "project" as const, key: "project-a" }] as const;
		const asOf = "2026-01-15T00:00:00.000Z";

		await searchEveryTier(createRecordingDeps(calls), { applicabilityContexts: contexts }, asOf);

		for (const provider of Object.keys(calls) as ProviderName[]) {
			expect(calls[provider], `${provider} provider was not called`).toHaveLength(1);
		}
		expectRuntimeOnEveryCall(calls, contexts, Date.parse(asOf));
	});

	it("does not add applicability fields to legacy provider inputs", async () => {
		const calls = createProviderCalls();

		await searchEveryTier(createRecordingDeps(calls), undefined, "not-a-timestamp");

		for (const input of allProviderInputs(calls)) {
			expect(input).not.toHaveProperty("applicabilityContexts");
			expect(input).not.toHaveProperty("applicabilityAt");
		}
	});

	it("captures one timestamp when asOf is omitted and shares it across all providers", async () => {
		const calls = createProviderCalls();
		const contexts: readonly MemoryApplicabilityContext[] = [];
		const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);

		await searchEveryTier(createRecordingDeps(calls), { applicabilityContexts: contexts });

		expect(now).toHaveBeenCalledTimes(1);
		expectRuntimeOnEveryCall(calls, contexts, 1_800_000_000_000);
	});

	it("keeps applicability out of the query rewriter while inheriting it in every rewritten search", async () => {
		const calls = createProviderCalls();
		const rewriteInputs: unknown[] = [];
		const reasoning: UnifiedSearchReasoningDeps = {
			queryRewriter: {
				rewrite: async (input) => {
					rewriteInputs.push(input);
					return [input.query, "Project Alpha history"];
				},
			},
		};
		const contexts = [{ scope: "project" as const, key: "project-a" }] as const;
		const asOf = "2026-02-01T00:00:00.000Z";

		await createUnifiedSearch(createRecordingDeps(calls, reasoning)).search(
			{
				userId: "u1",
				query: "Alpha project details",
				tiers: ["raw"],
				sources: ["memory"],
				reasoningStrategy: "rewrite",
				asOf,
			},
			{ applicabilityContexts: contexts },
		);

		expect(rewriteInputs).toHaveLength(1);
		expect(rewriteInputs[0]).not.toHaveProperty("applicabilityContexts");
		expect(rewriteInputs[0]).not.toHaveProperty("applicabilityAt");
		expect(calls.ann).toHaveLength(2);
		expectRuntimeOnEveryCall(calls, contexts, Date.parse(asOf));
	});

	it.each(["iterative", "union"] as const)(
		"keeps %s planner inputs unscoped and prevents executor requests from overriding runtime scope",
		async (reasoningStrategy) => {
			const calls = createProviderCalls();
			const plannerInputs: unknown[] = [];
			const planner: IterativeRecallPlanner = {
				plan: async (input) => {
					plannerInputs.push(input);
					const candidates = await input.executor.search({
						keywords: ["alpha"],
						applicabilityContexts: [{ scope: "project", key: "project-b" }],
						applicabilityAt: 0,
					} as unknown as IterativeRecallSearchRequest);
					return {
						evidence: candidates.candidates,
						stats: { iterations: 1, searches: 1, notes: 1 },
					};
				},
			};
			const contexts = [{ scope: "project" as const, key: "project-a" }] as const;
			const asOf = "2026-03-01T00:00:00.000Z";

			await createUnifiedSearch(createRecordingDeps(calls, { iterativePlanner: planner })).search(
				{
					userId: "u1",
					query: "Alpha project details",
					tiers: ["raw"],
					sources: ["memory"],
					reasoningStrategy,
					asOf,
				},
				{ applicabilityContexts: contexts },
			);

			expect(plannerInputs).toHaveLength(1);
			expect(plannerInputs[0]).not.toHaveProperty("applicabilityContexts");
			expect(plannerInputs[0]).not.toHaveProperty("applicabilityAt");
			expect(calls.ann.length).toBeGreaterThan(0);
			expect(calls.lexical.length).toBeGreaterThan(0);
			expectRuntimeOnEveryCall(calls, contexts, Date.parse(asOf));
		},
	);

	it("keeps synthesis evidence inside the scope enforced by a contract-compliant provider", async () => {
		const candidates: Array<UnifiedSearchKnowledgeResult & { applicability?: MemoryApplicabilityContext }> = [
			{
				chunkId: "global",
				documentId: "doc-global",
				documentName: "Global",
				content: "global guidance",
				similarity: 0.9,
				chunkIndex: 0,
				applicability: { scope: "global" },
			},
			{
				chunkId: "project-a",
				documentId: "doc-a",
				documentName: "Project A",
				content: "project A evidence",
				similarity: 0.8,
				chunkIndex: 0,
				applicability: { scope: "project", key: "project-a" },
			},
			{
				chunkId: "project-b",
				documentId: "doc-b",
				documentName: "Project B",
				content: "project B confidential evidence",
				similarity: 0.99,
				chunkIndex: 0,
				applicability: { scope: "project", key: "project-b" },
			},
		];
		const synthesisPrompts: string[] = [];
		const searchKnowledge: NonNullable<UnifiedSearchDeps["searchKnowledge"]> = async (input) => {
			if (input.applicabilityContexts === undefined || input.applicabilityAt === undefined) {
				throw new Error("trusted applicability context was not propagated");
			}
			const contexts = input.applicabilityContexts;
			const applicabilityAt = input.applicabilityAt;
			return candidates
				.filter((candidate) =>
					applicabilityMatchesTrustedContexts(candidate.applicability, contexts, applicabilityAt),
				)
				.map(({ applicability: _applicability, ...result }) => result);
		};
		const search = createUnifiedSearch({
			searchKnowledge,
			reasoning: {
				complete: async (prompt) => {
					synthesisPrompts.push(prompt);
					return "Supported by [1] and [2].";
				},
			},
		});

		const output = await search.search(
			{
				userId: "u1",
				query: "What applies to project A?",
				tiers: ["knowledge"],
				sources: ["knowledge"],
				synthesize: true,
				asOf: "2026-04-01T00:00:00.000Z",
			},
			{ applicabilityContexts: [{ scope: "project", key: "project-a" }] },
		);

		expect(output.results.map((result) => result.id)).toEqual(["global", "project-a"]);
		expect(output.evidence.map((evidence) => evidence.id)).toEqual(["global", "project-a"]);
		expect(output.answer).toBe("Supported by [1] and [2].");
		expect(synthesisPrompts).toHaveLength(1);
		expect(synthesisPrompts[0]).toContain("global guidance");
		expect(synthesisPrompts[0]).toContain("project A evidence");
		expect(synthesisPrompts[0]).not.toContain("project B confidential evidence");
	});
});
