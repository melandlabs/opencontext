import type { RawMessage, RawMessageSearchChunk } from "@melandlabs/indexeddb";
import type { DocumentChunk, IVectorStore, VectorSearchResult } from "@melandlabs/rag";

interface RawMessageChildCatalog {
	getMessageById(messageId: string): Promise<RawMessage | null | undefined>;
	getRawMessageSearchChunks(input: {
		chunkIds?: string[];
		messageIds?: string[];
		userId?: string;
	}): Promise<RawMessageSearchChunk[]>;
}

export interface RawMessageChildVectorIndexOptions {
	backend: "chroma" | "lancedb" | "milvus";
	store: IVectorStore;
	catalog: RawMessageChildCatalog;
}

export interface RawMessageChildSearchInput {
	userId: string;
	queryEmbedding: number[];
	query?: string;
	limit: number;
	threshold?: number;
	botId?: string;
	hybrid?: boolean;
}

export class RawMessageChildVectorIndex {
	readonly backend: RawMessageChildVectorIndexOptions["backend"];
	private readonly store: IVectorStore;
	private readonly catalog: RawMessageChildCatalog;

	constructor(options: RawMessageChildVectorIndexOptions) {
		this.backend = options.backend;
		this.store = options.store;
		this.catalog = options.catalog;
	}

	async replaceMessages(messages: RawMessage[], chunks: RawMessageSearchChunk[]): Promise<void> {
		const chunksByMessage = new Map<string, RawMessageSearchChunk[]>();
		for (const chunk of chunks) {
			const group = chunksByMessage.get(chunk.messageId) ?? [];
			group.push(chunk);
			chunksByMessage.set(chunk.messageId, group);
		}
		for (const message of messages) {
			await this.store.deleteDocument(message.messageId);
			const vectorChunks: DocumentChunk[] = (chunksByMessage.get(message.messageId) ?? [])
				.filter(
					(chunk): chunk is RawMessageSearchChunk & { embedding: number[] } =>
						Boolean(chunk.embedding?.length) && !chunk.embedding?.every((value) => value === 0),
				)
				.map((chunk) => ({
					id: chunk.chunkId,
					documentId: message.messageId,
					content: chunk.content,
					embedding: chunk.embedding,
					metadata: {
						userId: message.userId,
						botId: message.botId,
						platform: message.platform,
						timestamp: message.timestamp,
						chunkIndex: chunk.chunkIndex,
						chunkCount: chunk.chunkCount,
						startPosition: chunk.startPosition,
						endPosition: chunk.endPosition,
						contentHash: chunk.contentHash,
						embeddingModel: chunk.embeddingModel,
					},
				}));
			if (vectorChunks.length > 0) await this.store.addChunks(vectorChunks);
		}
	}

	async search(
		input: RawMessageChildSearchInput,
	): Promise<Array<{ id: string; content: string; similarity: number; metadata: Record<string, unknown> }>> {
		const results =
			input.hybrid && this.store.hybridSearch
				? await this.store.hybridSearch({
						text: input.query ?? "",
						vector: input.queryEmbedding,
						limit: input.limit,
						candidateLimit: input.limit,
						fusion: "rrf",
						filter: { userId: input.userId },
					})
				: await this.store.similaritySearch(input.queryEmbedding, input.limit, input.userId);
		return this.hydrate(results, input);
	}

	async getChunkCount(): Promise<number> {
		return this.store.getChunkCount();
	}

	private async hydrate(
		results: VectorSearchResult[],
		input: RawMessageChildSearchInput,
	): Promise<Array<{ id: string; content: string; similarity: number; metadata: Record<string, unknown> }>> {
		const matchedChunks = await this.catalog.getRawMessageSearchChunks({
			chunkIds: results.map((result) => result.id),
			userId: input.userId,
		});
		const matchedById = new Map(matchedChunks.map((chunk) => [chunk.chunkId, chunk]));
		const messageIds = [...new Set(matchedChunks.map((chunk) => chunk.messageId))];
		const [allChunks, parents] = await Promise.all([
			this.catalog.getRawMessageSearchChunks({ messageIds, userId: input.userId }),
			Promise.all(messageIds.map((messageId) => this.catalog.getMessageById(messageId))),
		]);
		const parentById = new Map(
			parents
				.filter((parent): parent is RawMessage => Boolean(parent))
				.map((parent) => [parent.messageId, parent]),
		);
		const chunksByMessage = new Map<string, RawMessageSearchChunk[]>();
		for (const chunk of allChunks) {
			const group = chunksByMessage.get(chunk.messageId) ?? [];
			group.push(chunk);
			chunksByMessage.set(chunk.messageId, group);
		}

		const strongest = new Map<
			string,
			{ id: string; content: string; similarity: number; metadata: Record<string, unknown> }
		>();
		for (const result of results) {
			const chunk = matchedById.get(result.id);
			if (!chunk) continue;
			const parent = parentById.get(chunk.messageId);
			if (!parent || (input.botId && parent.botId !== input.botId)) continue;
			if (input.threshold !== undefined && result.score < input.threshold) continue;
			const siblings = (chunksByMessage.get(parent.messageId) ?? []).sort(
				(a, b) => a.chunkIndex - b.chunkIndex,
			);
			const content =
				chunk.chunkCount <= 1
					? parent.content
					: parent.content.slice(
							siblings[Math.max(0, chunk.chunkIndex - 1)]?.startPosition ?? chunk.startPosition,
							siblings[Math.min(siblings.length - 1, chunk.chunkIndex + 1)]?.endPosition ?? chunk.endPosition,
						);
			const hit = {
				id: parent.messageId,
				content,
				similarity: result.score,
				metadata: {
					...(parent.metadata ?? {}),
					userId: parent.userId,
					botId: parent.botId,
					platform: parent.platform,
					timestamp: parent.timestamp,
					sourceMessageId: parent.messageId,
					sourceChunkId: chunk.chunkId,
					sourceChunkIndex: chunk.chunkIndex,
					sourceChunkCount: chunk.chunkCount,
					backend: this.backend,
					scoring: input.hybrid ? "native-hybrid" : "dense",
				},
			};
			const existing = strongest.get(parent.messageId);
			if (!existing || hit.similarity > existing.similarity) strongest.set(parent.messageId, hit);
		}
		return [...strongest.values()].sort((a, b) => b.similarity - a.similarity).slice(0, input.limit);
	}
}
