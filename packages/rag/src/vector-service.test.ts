import { describe, expect, it, vi } from "vitest";

import {
	type IVectorStore,
	type VectorSearchResult,
	configureVectorService,
	getVectorStore,
	searchHybridVectorStore,
} from "./vector-service";

function result(id: string, documentId = id): VectorSearchResult {
	return { id, documentId, content: id, score: 1 };
}

function createStore(overrides: Partial<IVectorStore> = {}): IVectorStore {
	return {
		addChunk: vi.fn(),
		addChunks: vi.fn(),
		similaritySearch: vi.fn().mockResolvedValue([]),
		deleteDocument: vi.fn(),
		getDocumentCount: vi.fn().mockResolvedValue(0),
		getChunkCount: vi.fn().mockResolvedValue(0),
		clear: vi.fn(),
		...overrides,
	};
}

describe("searchHybridVectorStore", () => {
	it("lazily creates and reuses a configured built-in backend", async () => {
		configureVectorService({
			backend: "lancedb",
			lancedb: { connection: {} },
		});

		const first = await getVectorStore();
		const second = await getVectorStore();

		expect(first).toBe(second);
		expect(first.hybridSearch).toBeTypeOf("function");
	});

	it("applies configured hybrid defaults to capable stores", async () => {
		const hybridSearch = vi.fn().mockResolvedValue([result("match")]);
		const store = createStore({ hybridSearch });
		configureVectorService({
			backend: "custom",
			getStore: async () => store,
			hybrid: {
				fusion: "weighted",
				alpha: 0.7,
				rrfK: 30,
				candidateMultiplier: 3,
			},
		});

		const results = await searchHybridVectorStore({
			text: "invoice-2024-017",
			vector: [1, 0],
			limit: 4,
		});

		expect(results).toEqual([result("match")]);
		expect(hybridSearch).toHaveBeenCalledWith({
			text: "invoice-2024-017",
			vector: [1, 0],
			limit: 4,
			fusion: "weighted",
			alpha: 0.7,
			rrfK: 30,
			candidateLimit: 12,
		});
	});

	it("keeps vector-only stores and disabled hybrid mode backwards compatible", async () => {
		const similaritySearch = vi
			.fn()
			.mockResolvedValue([result("allowed", "doc-1"), result("blocked", "doc-2")]);
		const hybridSearch = vi.fn();
		const store = createStore({ similaritySearch, hybridSearch });
		configureVectorService({
			getStore: async () => store,
			hybrid: { enabled: false },
		});

		const results = await searchHybridVectorStore({
			text: "exact keyword",
			vector: [0, 1],
			limit: 5,
			filter: { userId: "user-1", documentIds: ["doc-1"] },
		});

		expect(hybridSearch).not.toHaveBeenCalled();
		expect(similaritySearch).toHaveBeenCalledWith([0, 1], 5, "user-1");
		expect(results.map(({ id }) => id)).toEqual(["allowed"]);
	});
});
