import { describe, expect, it } from "vitest";
import { buildUnified, parseUnifiedArgs } from "./cli-shared";

describe("memory-store backend CLI", () => {
	it("parses the local reranker configuration", () => {
		const args = parseUnifiedArgs([
			"--reranker-provider",
			"local",
			"--reranker-model",
			"Xenova/ms-marco-MiniLM-L-6-v2",
			"--reranker-cache-dir",
			"C:/models/reranker",
			"--reranker-batch-size",
			"4",
			"--reranker-max-tokens",
			"384",
		]);

		expect(args).toMatchObject({
			rerankerProvider: "local",
			rerankerModel: "Xenova/ms-marco-MiniLM-L-6-v2",
			rerankerCacheDir: "C:/models/reranker",
			rerankerBatchSize: 4,
			rerankerMaxTokens: 384,
		});
	});

	it("parses the four supported raw-message backends and their connection settings", () => {
		const args = parseUnifiedArgs([
			"--embedding-provider",
			"none",
			"--memory-backend",
			"milvus",
			"--milvus-address",
			"http://milvus.test:19530",
			"--milvus-token",
			"secret-placeholder",
			"--milvus-database",
			"memory",
			"--milvus-collection",
			"raw_children",
			"--milvus-dimension",
			"384",
			"--insights-backend",
			"none",
			"--knowledge-backend",
			"none",
		]);

		expect(args).toMatchObject({
			memoryBackend: "milvus",
			milvusAddress: "http://milvus.test:19530",
			milvusToken: "secret-placeholder",
			milvusDatabase: "memory",
			milvusCollection: "raw_children",
			milvusDimension: 384,
		});
	});

	it.each([
		["chroma", "--memory-backend=chroma requires --chroma-url"],
		["lancedb", "--memory-backend=lancedb requires --lancedb-uri"],
		["milvus", "--memory-backend=milvus requires --milvus-address"],
	] as const)("fails %s configuration before opening a backend", async (backend, message) => {
		await expect(
			buildUnified({
				embeddingProvider: "none",
				rerankerProvider: "none",
				memoryBackend: backend,
				insightsBackend: "none",
				insightsCollection: "insights",
				knowledgeBackend: "none",
				knowledgeCollection: "knowledge",
				reasoning: false,
			}),
		).rejects.toThrow(message);
	});
});
