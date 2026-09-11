import { workspaceEmbedDocuments, workspaceEmbeddingModelName } from "./embedding-provider";
import type { SqliteWorkspaceStore } from "./sqlite";

const DEFAULT_BATCH_SIZE = 100;
// 384 = Xenova/all-MiniLM-L6-v2 (local). Cloud picks 1536 dynamically.
const DEFAULT_DIMENSIONS = 384;

export interface EmbeddingQueueDeps {
	store: SqliteWorkspaceStore;
	batchSize?: number;
	dimensions?: number;
}

export interface EmbeddingQueue {
	/**
	 * Enqueue an embedding job for a specific `(resource_id, version_id)` pair.
	 * Resolves once the job has been scheduled into the serial queue; it
	 * does NOT wait for embedding completion.
	 */
	enqueue(input: { resource_id: number; version_id: number; jobId?: number }): Promise<void>;
	/** Test-only: drain the serial queue and wait for all pending jobs. */
	drain(): Promise<void>;
}

class DefaultEmbeddingQueue implements EmbeddingQueue {
	private readonly store: SqliteWorkspaceStore;
	private readonly batchSize: number;
	private readonly dimensions: number;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(deps: EmbeddingQueueDeps) {
		this.store = deps.store;
		this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
		this.dimensions = deps.dimensions ?? DEFAULT_DIMENSIONS;
	}

	enqueue(input: { resource_id: number; version_id: number; jobId?: number }): Promise<void> {
		const next = this.queue.then(async () => {
			await this.runJob(input);
		});
		// Swallow rejections on the chained promise so one failed job does
		// not poison subsequent ones. Per-job errors are persisted into
		// `workspace_jobs.error` and the per-resource `index_status`.
		this.queue = next.catch(() => undefined);
		return next.catch(() => undefined);
	}

	drain(): Promise<void> {
		return this.queue.then(() => undefined);
	}

	private async runJob(input: { resource_id: number; version_id: number; jobId?: number }): Promise<void> {
		try {
			let totalProcessed = 0;
			// Loop until no more unembedded chunks remain for this version.
			// Each iteration pulls one batch worth; the loop terminates when
			// the SELECT returns fewer rows than the batch size.
			while (true) {
				const batch = this.store.fetchPendingChunks(input.version_id, this.batchSize);
				if (batch.length === 0) break;
				const texts = batch.map((row) => row.content);
				let embeddings: number[][];
				let model = "unknown";
				try {
					embeddings = await workspaceEmbedDocuments(texts);
					model = await workspaceEmbeddingModelName();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.store.markJobFailed(input.jobId ?? null, message);
					// Partial failure: leave whatever was already written in place;
					// the resource is marked `partial` so callers can retry.
					this.store.markVersionEmbeddingPartial(input.resource_id, input.version_id, message);
					return;
				}
				const dimensions = embeddings[0]?.length ?? this.dimensions;
				this.store.ensureChildVectorTable(dimensions);
				this.store.writeChunkEmbeddings(
					batch.map((row, i) => ({ chunkId: row.chunk_id, embedding: embeddings[i] ?? [] })),
					model,
					dimensions,
				);
				totalProcessed += batch.length;
				if (batch.length < this.batchSize) break;
			}
			this.store.markVersionEmbeddingReady(input.resource_id, input.version_id);
			if (input.jobId !== undefined) {
				this.store.completeJob(input.jobId, totalProcessed);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.store.markJobFailed(input.jobId ?? null, message);
			this.store.markVersionEmbeddingFailed(input.resource_id, input.version_id, message);
		}
	}
}

export function createEmbeddingQueue(deps: EmbeddingQueueDeps): EmbeddingQueue {
	return new DefaultEmbeddingQueue(deps);
}
