import type { RawMessage, RawMessageSearchChunk } from "@melandlabs/indexeddb";
import type { DocumentChunk, HybridSearchQuery, IVectorStore, VectorSearchResult } from "@melandlabs/rag";
import { describe, expect, it, vi } from "vitest";
import { RawMessageChildVectorIndex } from "./raw-message-child-vector-index";

class FakeVectorStore implements IVectorStore {
	readonly added: DocumentChunk[] = [];
	readonly deleted: string[] = [];
	results: VectorSearchResult[] = [];
	hybridQuery?: HybridSearchQuery;

	async addChunk(chunk: DocumentChunk): Promise<void> {
		this.added.push(chunk);
	}
	async addChunks(chunks: DocumentChunk[]): Promise<void> {
		this.added.push(...chunks);
	}
	async similaritySearch(): Promise<VectorSearchResult[]> {
		return this.results;
	}
	async hybridSearch(query: HybridSearchQuery): Promise<VectorSearchResult[]> {
		this.hybridQuery = query;
		return this.results;
	}
	async deleteDocument(documentId: string): Promise<void> {
		this.deleted.push(documentId);
	}
	async getDocumentCount(): Promise<number> {
		return new Set(this.added.map((chunk) => chunk.documentId)).size;
	}
	async getChunkCount(): Promise<number> {
		return this.added.length;
	}
	async clear(): Promise<void> {
		this.added.length = 0;
	}
}

const parent: RawMessage = {
	messageId: "parent-1",
	userId: "user-1",
	botId: "bot-1",
	platform: "test",
	content: "AAAABBBBCCCC",
	timestamp: 1,
	createdAt: 1,
};

const chunks: RawMessageSearchChunk[] = [
	{
		chunkId: "parent-1:0",
		messageId: parent.messageId,
		userId: parent.userId,
		chunkIndex: 0,
		chunkCount: 3,
		startPosition: 0,
		endPosition: 4,
		content: "AAAA",
		contentHash: "a",
		embedding: [1, 0],
		embeddingDimensions: 2,
	},
	{
		chunkId: "parent-1:1",
		messageId: parent.messageId,
		userId: parent.userId,
		chunkIndex: 1,
		chunkCount: 3,
		startPosition: 4,
		endPosition: 8,
		content: "BBBB",
		contentHash: "b",
		embedding: [0.8, 0.2],
		embeddingDimensions: 2,
	},
	{
		chunkId: "parent-1:2",
		messageId: parent.messageId,
		userId: parent.userId,
		chunkIndex: 2,
		chunkCount: 3,
		startPosition: 8,
		endPosition: 12,
		content: "CCCC",
		contentHash: "c",
		embedding: [0, 0],
		embeddingDimensions: 2,
	},
];

function createIndex(store: FakeVectorStore) {
	return new RawMessageChildVectorIndex({
		backend: "lancedb",
		store,
		catalog: {
			getMessageById: vi.fn(async (messageId) => (messageId === parent.messageId ? parent : null)),
			getRawMessageSearchChunks: vi.fn(async (input) => {
				if (input.chunkIds) return chunks.filter((chunk) => input.chunkIds?.includes(chunk.chunkId));
				if (input.messageIds) return chunks.filter((chunk) => input.messageIds?.includes(chunk.messageId));
				return [];
			}),
		},
	});
}

describe("RawMessageChildVectorIndex", () => {
	it("replaces a parent with only independently embedded, non-zero child vectors", async () => {
		const store = new FakeVectorStore();
		const index = createIndex(store);

		await index.replaceMessages([parent], chunks);

		expect(store.deleted).toEqual([parent.messageId]);
		expect(store.added.map((chunk) => chunk.id)).toEqual(["parent-1:0", "parent-1:1"]);
		expect(store.added.every((chunk) => chunk.documentId === parent.messageId)).toBe(true);
		expect(store.added.every((chunk) => chunk.content !== parent.content)).toBe(true);
	});

	it("deduplicates child hits to the parent and restores one continuous three-child window", async () => {
		const store = new FakeVectorStore();
		store.results = [
			{ id: "parent-1:1", documentId: parent.messageId, content: "BBBB", score: 0.9 },
			{ id: "parent-1:0", documentId: parent.messageId, content: "AAAA", score: 0.8 },
		];
		const index = createIndex(store);

		const results = await index.search({
			userId: parent.userId,
			query: "BBBB",
			queryEmbedding: [1, 0],
			limit: 8,
			hybrid: true,
		});

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ id: parent.messageId, content: parent.content, similarity: 0.9 });
		expect(results[0]?.metadata).toMatchObject({
			sourceMessageId: parent.messageId,
			sourceChunkId: "parent-1:1",
			backend: "lancedb",
			scoring: "native-hybrid",
		});
		expect(store.hybridQuery).toMatchObject({ limit: 8, candidateLimit: 8, fusion: "rrf" });
	});
});
