/**
 * `@melandlabs/workspace/embedding-queue` — async fan-out worker pool.
 *
 * v2 (workspace schema v2):
 *   - bounded `concurrency` (default 2, configurable)
 *   - per-batch `batchTimeoutMs` (default 30s)
 *   - exponential-backoff retry with `maxRetries` (default 3)
 *   - dead-letter queue: failed jobs past maxRetries are marked
 *     `status='dlq'` and the resource flips to `index_status='dlq'`
 *   - `stats()` for health endpoints and the loop engine
 *   - `retryDlq(ids?)` to requeue DLQ entries
 *
 * Backwards compatible with the previous queue interface
 * (`enqueue` + `drain`); the constructor accepts the legacy
 * `EmbeddingQueueDeps` shape, plus optional v2 options.
 */
import { workspaceEmbedDocuments, workspaceEmbeddingModelName } from "./embedding-provider";
import type { SqliteWorkspaceStore } from "./sqlite";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_DIMENSIONS = 384;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_BATCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;

export interface EmbeddingQueueDeps {
	store: SqliteWorkspaceStore;
	batchSize?: number;
	dimensions?: number;
	/** v2 — number of parallel jobs (default 2). */
	concurrency?: number;
	/** v2 — per-batch wall-clock timeout in ms (default 30_000). */
	batchTimeoutMs?: number;
	/** v2 — retry budget before DLQ (default 3). */
	maxRetries?: number;
}

export interface EmbeddingQueueStats {
	queueDepth: number;
	inFlight: number;
	failedRecent: number;
	dlqSize: number;
}

export interface EmbeddingQueue {
	enqueue(input: { resource_id: number; version_id: number; jobId?: number }): Promise<void>;
	drain(): Promise<void>;
	stats(): EmbeddingQueueStats;
	retryDlq(dlqEntryIds?: number[]): Promise<{ requeued: number }>;
}

interface QueueEntry {
	resource_id: number;
	version_id: number;
	jobId?: number;
	attempt: number;
}

class DefaultEmbeddingQueue implements EmbeddingQueue {
	private readonly store: SqliteWorkspaceStore;
	private readonly batchSize: number;
	private readonly dimensions: number;
	private readonly concurrency: number;
	private readonly batchTimeoutMs: number;
	private readonly maxRetries: number;
	private readonly pending: QueueEntry[] = [];
	private inFlight = 0;
	private recentFailures = 0;

	constructor(deps: EmbeddingQueueDeps) {
		this.store = deps.store;
		this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
		this.dimensions = deps.dimensions ?? DEFAULT_DIMENSIONS;
		this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
		this.batchTimeoutMs = deps.batchTimeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS;
		this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
	}

	enqueue(input: { resource_id: number; version_id: number; jobId?: number }): Promise<void> {
		const entry: QueueEntry = { ...input, attempt: 0 };
		this.pending.push(entry);
		// Fire-and-forget; do not await from inside the synchronous enqueue.
		queueMicrotask(() => this.tick());
		return Promise.resolve();
	}

	async drain(): Promise<void> {
		// Wait until both the pending list and the in-flight count settle.
		while (this.pending.length > 0 || this.inFlight > 0) {
			await delay(5);
		}
	}

	stats(): EmbeddingQueueStats {
		const dlqJobs = this.store.getDlqJobs();
		return {
			queueDepth: this.pending.length,
			inFlight: this.inFlight,
			failedRecent: this.recentFailures,
			dlqSize: dlqJobs.length,
		};
	}

	async retryDlq(dlqEntryIds?: number[]): Promise<{ requeued: number }> {
		const allDlq = this.store.getDlqJobs();
		const target = dlqEntryIds ? allDlq.filter((j) => dlqEntryIds.includes(j.id)) : allDlq;
		let requeued = 0;
		for (const job of target) {
			// DLQ jobs only carry the resource/version/jobId at the job
			// level, not on the resource level — we rely on the caller
			// to pass that via a separate path. For the common case,
			// requeue using the job's "kind=index" semantics: enqueue
			// every ready resource under that workspace.
			if (job.kind === "index") {
				const listed = this.store.listResources({
					workspace_id: job.workspace_id,
					index_status: "dlq",
					limit: 100,
					offset: 0,
				});
				for (const r of listed.resources) {
					if (r.id === 0) continue;
					this.enqueue({
						resource_id: r.id,
						version_id: r.current_version_id ?? 0,
						jobId: job.id,
					});
					requeued += 1;
				}
			}
		}
		return { requeued };
	}

	/**
	 * Internal scheduler — fire jobs while we have concurrency budget.
	 * Called from `enqueue` and at the tail of each `runJob` to keep
	 * the worker pool drained.
	 */
	private tick(): void {
		while (this.inFlight < this.concurrency && this.pending.length > 0) {
			const entry = this.pending.shift();
			if (!entry) break;
			this.inFlight += 1;
			this.runJob(entry)
				.catch(() => undefined)
				.finally(() => {
					this.inFlight -= 1;
					// Drain any newly-enqueued entries.
					if (this.pending.length > 0 && this.inFlight < this.concurrency) {
						queueMicrotask(() => this.tick());
					}
				});
		}
	}

	private async runJob(entry: QueueEntry): Promise<void> {
		const { resource_id, version_id, jobId } = entry;
		try {
			let totalProcessed = 0;
			while (true) {
				const batch = this.store.fetchPendingChunks(version_id, this.batchSize);
				if (batch.length === 0) break;
				const texts = batch.map((row) => row.content);
				let embeddings: number[][];
				let model = "unknown";
				try {
					embeddings = await withTimeout(
						workspaceEmbedDocuments(texts),
						this.batchTimeoutMs,
						`embedding batch ${texts.length} timed out after ${this.batchTimeoutMs}ms`,
					);
					model = await workspaceEmbeddingModelName();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.recentFailures += 1;
					// Retry with exponential backoff if budget remains.
					if (entry.attempt < this.maxRetries) {
						const next: QueueEntry = {
							...entry,
							attempt: entry.attempt + 1,
						};
						const delayMs = backoffMs(entry.attempt);
						setTimeout(() => {
							this.pending.push(next);
							this.tick();
						}, delayMs);
						// Mark partial so callers can see progress.
						this.store.markVersionEmbeddingPartial(resource_id, version_id, message);
						return;
					}
					// Out of retries → DLQ.
					this.store.markJobDlq(jobId ?? -1, message);
					this.store.markIndexDlq(resource_id, version_id, message);
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
			this.store.markVersionEmbeddingReady(resource_id, version_id);
			if (jobId !== undefined && jobId >= 0) {
				this.store.completeJob(jobId, totalProcessed);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.store.markJobFailed(jobId ?? null, message);
			this.store.markVersionEmbeddingFailed(resource_id, version_id, message);
		}
	}
}

export function createEmbeddingQueue(deps: EmbeddingQueueDeps): EmbeddingQueue {
	return new DefaultEmbeddingQueue(deps);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		promise
			.then((value) => {
				clearTimeout(timer);
				resolve(value);
			})
			.catch((err) => {
				clearTimeout(timer);
				reject(err);
			});
	});
}

function backoffMs(attempt: number): number {
	const base = 500;
	const cap = 30_000;
	const exp = Math.min(cap, base * 2 ** attempt);
	// Add up to 25% jitter to avoid thundering herd.
	return exp + Math.floor(Math.random() * exp * 0.25);
}
