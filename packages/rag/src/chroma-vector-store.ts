/**
 * ChromaVectorStore — minimal HTTP client for ChromaDB.
 *
 * Implemented against the Chroma `/api/v1` REST surface. Used by
 * `@melandlabs/memory-store` for the optional raw-message child-vector index
 * selected with `MEMORY_BACKEND=chroma`.
 */

import type { DocumentChunk, IVectorStore, VectorSearchResult } from "./vector-service";

export interface ChromaVectorStoreOptions {
	url?: string;
	collectionName: string;
}

interface ChromaAddPayload {
	ids: string[];
	embeddings: number[][];
	documents: string[];
	metadatas: Record<string, unknown>[];
}

export class ChromaVectorStore implements IVectorStore {
	private readonly url: string;
	private readonly collectionName: string;

	constructor(opts: ChromaVectorStoreOptions) {
		this.url = (opts.url ?? "http://localhost:8000").replace(/\/+$/, "");
		this.collectionName = opts.collectionName;
	}

	async addChunk(chunk: DocumentChunk): Promise<void> {
		await this.addChunks([chunk]);
	}

	async addChunks(chunks: DocumentChunk[]): Promise<void> {
		if (chunks.length === 0) return;
		const payload: ChromaAddPayload = {
			ids: chunks.map((c) => c.id),
			embeddings: chunks.map((c) => c.embedding),
			documents: chunks.map((c) => c.content),
			metadatas: chunks.map((c) => ({ ...(c.metadata ?? {}), documentId: c.documentId })),
		};
		const res = await fetch(`${this.collectionUrl()}/upsert`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			throw new Error(
				`ChromaVectorStore.addChunks failed: ${res.status} ${res.statusText} for collection ${this.collectionName}`,
			);
		}
	}

	async similaritySearch(
		queryEmbedding: number[],
		limit = 10,
		userId?: string,
	): Promise<VectorSearchResult[]> {
		const res = await fetch(`${this.collectionUrl()}/query`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query_embeddings: [queryEmbedding],
				n_results: limit,
				include: ["documents", "metadatas", "distances"],
				...(userId ? { where: { userId } } : {}),
			}),
		});
		if (!res.ok) {
			throw new Error(
				`ChromaVectorStore.similaritySearch failed: ${res.status} ${res.statusText} for collection ${this.collectionName}`,
			);
		}
		const body = (await res.json()) as {
			ids?: string[][];
			documents?: Array<Array<string | null>>;
			metadatas?: Array<Array<Record<string, unknown> | null>>;
			distances?: Array<Array<number | null>>;
		};
		const ids = body.ids?.[0] ?? [];
		return ids.map((id, index) => {
			const metadata = body.metadatas?.[0]?.[index] ?? {};
			const distance = body.distances?.[0]?.[index];
			return {
				id,
				documentId: String(metadata.documentId ?? ""),
				content: body.documents?.[0]?.[index] ?? "",
				score: typeof distance === "number" ? 1 / (1 + Math.max(0, distance)) : 0,
				metadata,
			};
		});
	}

	async deleteDocument(documentId: string): Promise<void> {
		const res = await fetch(`${this.collectionUrl()}/delete`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ where: { documentId } }),
		});
		if (!res.ok) {
			throw new Error(
				`ChromaVectorStore.deleteDocument failed: ${res.status} ${res.statusText} for collection ${this.collectionName}`,
			);
		}
	}

	async getDocumentCount(): Promise<number> {
		return this.getChunkCount();
	}

	async getChunkCount(): Promise<number> {
		const res = await fetch(`${this.collectionUrl()}/count`, { method: "GET" });
		if (!res.ok) {
			throw new Error(
				`ChromaVectorStore.getChunkCount failed: ${res.status} ${res.statusText} for collection ${this.collectionName}`,
			);
		}
		const body = (await res.json()) as number | { count?: number };
		return typeof body === "number" ? body : (body.count ?? 0);
	}

	async clear(): Promise<void> {
		const res = await fetch(this.collectionUrl(), { method: "DELETE" });
		if (!res.ok && res.status !== 404) {
			throw new Error(
				`ChromaVectorStore.clear failed: ${res.status} ${res.statusText} for collection ${this.collectionName}`,
			);
		}
	}

	private collectionUrl(): string {
		return `${this.url}/api/v1/collections/${encodeURIComponent(this.collectionName)}`;
	}
}
