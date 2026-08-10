/**
 * ChromaVectorStore — minimal HTTP client for ChromaDB.
 *
 * Implemented against the Chroma `/api/v1` REST surface. Used by
 * `@melandlabs/memory-store`'s optional Chroma-backed vector index
 * (selected via the `RAW_MESSAGE_VECTOR_STORE_BACKEND=chroma` env var).
 * Only active when those env vars are set; sqlite-vec is the default.
 */

import type { DocumentChunk } from "./vector-service";

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

export class ChromaVectorStore {
	private readonly url: string;
	private readonly collectionName: string;

	constructor(opts: ChromaVectorStoreOptions) {
		this.url = (opts.url ?? "http://localhost:8000").replace(/\/+$/, "");
		this.collectionName = opts.collectionName;
	}

	async addChunks(chunks: DocumentChunk[]): Promise<void> {
		if (chunks.length === 0) return;
		const payload: ChromaAddPayload = {
			ids: chunks.map((c) => c.id),
			embeddings: chunks.map((c) => c.embedding),
			documents: chunks.map((c) => c.content),
			metadatas: chunks.map((c) => c.metadata ?? {}),
		};
		const res = await fetch(
			`${this.url}/api/v1/collections/${encodeURIComponent(this.collectionName)}/add`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			},
		);
		if (!res.ok) {
			throw new Error(
				`ChromaVectorStore.addChunks failed: ${res.status} ${res.statusText} for collection ${this.collectionName}`,
			);
		}
	}
}
