import { describe, expect, it, vi } from "vitest";

import { HybridSearchAdapter, fuseHybridResults } from "./hybrid-search";
import type { IVectorStore, VectorSearchResult } from "./vector-service";

function result(id: string, score: number, documentId = id): VectorSearchResult {
	return { id, documentId, content: id, score };
}

describe("fuseHybridResults", () => {
	it("uses reciprocal rank fusion and rewards candidates present in both branches", () => {
		const fused = fuseHybridResults({
			dense: [result("dense-only", 0.99), result("both", 0.8)],
			lexical: [result("lexical-only", 25), result("both", 20)],
			strategy: "rrf",
			limit: 3,
		});

		expect(fused.map(({ id }) => id)).toEqual(["both", "dense-only", "lexical-only"]);
		expect(fused[0].score).toBeCloseTo(2 / 62);
	});

	it("normalizes incomparable score ranges before weighted fusion", () => {
		const fused = fuseHybridResults({
			dense: [result("semantic", 0.9), result("literal", 0.1)],
			lexical: [result("literal", 200), result("semantic", 10)],
			strategy: "weighted",
			alpha: 0.8,
			limit: 2,
		});

		expect(fused.map(({ id }) => id)).toEqual(["semantic", "literal"]);
		expect(fused[0].score).toBeCloseTo(0.8);
		expect(fused[1].score).toBeCloseTo(0.2);
	});

	it("deduplicates repeated ids within a branch", () => {
		const fused = fuseHybridResults({
			dense: [result("a", 1), result("a", 0.9)],
			lexical: [],
			strategy: "rrf",
		});
		expect(fused).toHaveLength(1);
	});

	it("improves MRR@10 by at least 10% on the fixed keyword-heavy benchmark", () => {
		const benchmark = [
			{
				relevant: "invoice-2024-017",
				dense: ["billing-policy", "invoice-2024-017", "invoice-template"],
				lexical: ["invoice-2024-017", "invoice-2024-071", "billing-policy"],
			},
			{
				relevant: "ERR_CONN_RESET_42",
				dense: ["network-runbook", "proxy-errors", "ERR_CONN_RESET_42"],
				lexical: ["ERR_CONN_RESET_42", "network-runbook", "timeout-errors"],
			},
			{
				relevant: "PRJ-NORTHSTAR-88",
				dense: ["project-roadmap", "PRJ-NORTHSTAR-88", "northstar-notes"],
				lexical: ["PRJ-NORTHSTAR-88", "PRJ-NORTHSTAR-18", "project-roadmap"],
			},
			{
				relevant: "CVE-2026-1042",
				dense: ["security-advisory", "patch-guide", "CVE-2026-1042"],
				lexical: ["CVE-2026-1042", "security-advisory", "CVE-2026-1402"],
			},
		];

		const reciprocalRank = (ranking: string[], relevant: string): number => {
			const index = ranking.slice(0, 10).indexOf(relevant);
			return index === -1 ? 0 : 1 / (index + 1);
		};
		const mean = (values: number[]): number =>
			values.reduce((total, value) => total + value, 0) / values.length;

		const denseMrr = mean(benchmark.map(({ dense, relevant }) => reciprocalRank(dense, relevant)));
		const hybridMrr = mean(
			benchmark.map(({ dense, lexical, relevant }) => {
				const fused = fuseHybridResults({
					dense: dense.map((id, index) => result(id, 1 - index * 0.1)),
					lexical: lexical.map((id, index) => result(id, 100 - index)),
					limit: 10,
				});
				return reciprocalRank(
					fused.map(({ id }) => id),
					relevant,
				);
			}),
		);

		expect(hybridMrr).toBeGreaterThanOrEqual(denseMrr * 1.1);
	});
});

describe("HybridSearchAdapter", () => {
	it("runs both providers, pushes user filters, and post-filters document ids", async () => {
		const vectorStore: IVectorStore = {
			addChunk: vi.fn(),
			addChunks: vi.fn(),
			similaritySearch: vi
				.fn()
				.mockResolvedValue([
					result("dense-allowed", 0.9, "allowed"),
					result("dense-blocked", 0.8, "blocked"),
				]),
			deleteDocument: vi.fn(),
			getDocumentCount: vi.fn().mockResolvedValue(0),
			getChunkCount: vi.fn().mockResolvedValue(0),
			clear: vi.fn(),
		};
		const lexicalSearch = {
			search: vi.fn().mockResolvedValue([result("lexical-allowed", 5, "allowed")]),
		};
		const adapter = new HybridSearchAdapter({ vectorStore, lexicalSearch });

		const results = await adapter.hybridSearch({
			text: "Northstar",
			vector: [1, 0],
			limit: 2,
			filter: { userId: "user-1", documentIds: ["allowed"] },
		});

		expect(vectorStore.similaritySearch).toHaveBeenCalledWith([1, 0], 8, "user-1");
		expect(lexicalSearch.search).toHaveBeenCalledWith("Northstar", 8, {
			userId: "user-1",
			documentIds: ["allowed"],
		});
		expect(results.map(({ id }) => id).sort()).toEqual(["dense-allowed", "lexical-allowed"]);
	});
});
