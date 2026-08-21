import type { CreateCollectionWithFieldsReq, HybridSearchReq, MilvusClient } from "@zilliz/milvus2-sdk-node";
import { describe, expect, it, vi } from "vitest";

import { MilvusStore } from "./milvus-store";

describe("MilvusStore", () => {
	it("creates one dense+sparse collection and issues a filtered hybrid request", async () => {
		const client = {
			hasCollection: vi.fn().mockResolvedValue({ value: false }),
			createCollection: vi.fn().mockResolvedValue({}),
			listIndexes: vi.fn().mockResolvedValue({ indexes: [] }),
			createIndex: vi.fn().mockResolvedValue({}),
			loadCollection: vi.fn().mockResolvedValue({}),
			upsert: vi.fn().mockResolvedValue({}),
			search: vi.fn().mockResolvedValue({
				results: [
					{
						id: "chunk-1",
						document_id: "doc-1",
						content: "Project Northstar",
						metadata: { userId: "alice" },
						score: 0.75,
					},
				],
			}),
			delete: vi.fn(),
			count: vi.fn().mockResolvedValue({ data: 1 }),
			queryIterator: vi.fn(),
			dropCollection: vi.fn(),
			closeConnection: vi.fn(),
		} as unknown as MilvusClient;
		const store = new MilvusStore({ client, collectionName: "test_chunks" });

		await store.addChunk({
			id: "chunk-1",
			documentId: "doc-1",
			content: "Project Northstar",
			embedding: [1, 0, 0],
			metadata: { userId: "alice" },
		});

		expect(client.createCollection).toHaveBeenCalledTimes(1);
		const createRequest = vi.mocked(client.createCollection).mock
			.calls[0][0] as CreateCollectionWithFieldsReq;
		expect(createRequest.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "dense_vector", dim: 3 }),
				expect.objectContaining({ name: "sparse_vector", is_function_output: true }),
			]),
		);
		expect(createRequest.functions).toEqual([
			expect.objectContaining({
				input_field_names: ["content"],
				output_field_names: ["sparse_vector"],
			}),
		]);
		expect(client.createIndex).toHaveBeenCalledTimes(1);
		expect(client.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				collection_name: "test_chunks",
				data: [expect.objectContaining({ id: "chunk-1", dense_vector: [1, 0, 0] })],
			}),
		);

		const results = await store.hybridSearch({
			text: "Northstar",
			vector: [1, 0, 0],
			filter: { userId: "alice", documentIds: ["doc-1"] },
			fusion: "weighted",
			alpha: 0.7,
			limit: 1,
		});

		const searchRequest = vi.mocked(client.search).mock.calls[0][0] as HybridSearchReq;
		expect(searchRequest.data).toHaveLength(2);
		expect(searchRequest.data[0]).toEqual(
			expect.objectContaining({ anns_field: "dense_vector", data: [1, 0, 0] }),
		);
		expect(searchRequest.data[1]).toEqual(
			expect.objectContaining({ anns_field: "sparse_vector", data: "Northstar" }),
		);
		expect(searchRequest.data[0].expr).toContain('user_id == "alice"');
		expect(searchRequest.data[0].expr).toContain('document_id in ["doc-1"]');
		const rerank = searchRequest.rerank as { strategy: string; params: { weights: number[] } };
		expect(rerank.strategy).toBe("weighted");
		expect(rerank.params.weights[0]).toBeCloseTo(0.7);
		expect(rerank.params.weights[1]).toBeCloseTo(0.3);
		expect(results).toEqual([expect.objectContaining({ id: "chunk-1", documentId: "doc-1", score: 0.75 })]);
	});
});
