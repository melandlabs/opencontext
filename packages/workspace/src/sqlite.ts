/**
 * `@melandlabs/workspace/sqlite` — the SQLite-backed store.
 *
 * Public surface:
 *
 *   - `SqliteWorkspaceStore`        — CRUD + indexing pipeline
 *   - `getSQLiteWorkspaceStore()`  — singleton accessor (lazy open)
 *   - `closeSQLiteWorkspaceStore()`— test-only teardown
 *   - `resolveWorkspaceDbPath(dbPath?)` — same env-var fallback as
 *     `@melandlabs/memory-store`'s `resolveSQLiteRawMessageDbPath`
 *     (`MEMORY_STORE_DB_PATH` → `~/.opencontext/memory/store.db`)
 *
 * Design notes (mirrors `SQLiteRawMessageManager` patterns):
 *
 *   - One SQLite file is shared with the rest of the memory store so
 *     the user's local data lives under a single `~/.opencontext/memory/store.db`.
 *     The vec0 child table is created lazily by
 *     `ensureChildVectorTable(dimensions)` — same as
 *     `packages/sqlite/src/raw-message-manager.ts:1859-1874`.
 *   - `indexResource` runs the **sync** portion of the indexing pipeline
 *     (sha256, version chain, chunk insert, FTS5 mirror) inside one
 *     `better-sqlite3` transaction. The async embedding fan-out is
 *     delegated to `EmbeddingQueue`, which writes the embedding +
 *     vec0 row + `index_status` flip in subsequent transactions.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { chunkTextByEstimatedTokens, RAW_MESSAGE_CHUNK_MAX_TOKENS, RAW_MESSAGE_CHUNK_OVERLAP_TOKENS } from "@melandlabs/shared";
import { getOpenContextPath } from "@melandlabs/env-config";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { bufferToFloatArray, floatArrayToBuffer } from "@melandlabs/sqlite";
import type {
	ListWorkspaceResourcesInput,
	ListWorkspaceResourcesResult,
	OkfFolderResource,
	WorkspaceChunk,
	WorkspaceEdgeType,
	WorkspaceIndexStatus,
	WorkspaceJob,
	WorkspaceReferenceEdge,
	WorkspaceResource,
	WorkspaceResourceVersion,
	WorkspaceSearchHit,
	WorkspaceSearchStrategy,
	SearchWorkspaceContextInput,
	SearchWorkspaceContextResult,
	UpdateWorkspaceContextInput,
	UpdateWorkspaceContextResult,
} from "./types";
import { initializeWorkspaceSchema } from "./schema";

type DatabaseLike = Database.Database;

interface WorkspaceResourceRow {
	id: number;
	workspace_id: string;
	user_id: string;
	resource_type: string;
	canonical_key: string;
	title: string;
	storage_kind: string;
	current_version_id: number | null;
	index_status: string;
	created_at: number;
	updated_at: number;
	metadata: string | null;
}

interface WorkspaceResourceVersionRow {
	id: number;
	resource_id: number;
	version_number: number;
	sha256: string;
	change_kind: string;
	size_bytes: number;
	parent_version_id: number | null;
	source_path: string | null;
	created_at: number;
	metadata: string | null;
}

interface WorkspaceChunkRow {
	id: number;
	chunk_id: string;
	resource_id: number;
	version_id: number;
	workspace_id: string;
	chunk_index: number;
	chunk_count: number;
	start_position: number;
	end_position: number;
	content: string;
	content_hash: string;
	embedding: Buffer | null;
	embedding_model: string | null;
	embedding_dimensions: number | null;
	embedding_updated_at: number | null;
}

interface WorkspaceReferenceEdgeRow {
	id: number;
	workspace_id: string;
	source_resource_id: number;
	source_version_id: number | null;
	target_resource_id: number;
	target_version_id: number | null;
	edge_type: string;
	quote: string | null;
	created_at: number;
}

interface WorkspaceJobRow {
	id: number;
	workspace_id: string;
	kind: string;
	status: string;
	total: number;
	done: number;
	error: string | null;
	created_at: number;
	updated_at: number;
}

function toWorkspaceResource(row: WorkspaceResourceRow): WorkspaceResource {
	return {
		id: row.id,
		workspace_id: row.workspace_id,
		user_id: row.user_id,
		resource_type: row.resource_type,
		canonical_key: row.canonical_key,
		title: row.title,
		storage_kind: row.storage_kind as WorkspaceResource["storage_kind"],
		current_version_id: row.current_version_id,
		index_status: row.index_status as WorkspaceIndexStatus,
		created_at: row.created_at,
		updated_at: row.updated_at,
		metadata: parseJson<Record<string, unknown>>(row.metadata, {} as Record<string, unknown>),
	};
}

function toWorkspaceResourceVersion(row: WorkspaceResourceVersionRow): WorkspaceResourceVersion {
	return {
		id: row.id,
		resource_id: row.resource_id,
		version_number: row.version_number,
		sha256: row.sha256,
		change_kind: row.change_kind as WorkspaceResourceVersion["change_kind"],
		size_bytes: row.size_bytes,
		parent_version_id: row.parent_version_id,
		source_path: row.source_path,
		created_at: row.created_at,
		metadata: parseJson<Record<string, unknown>>(row.metadata, {} as Record<string, unknown>),
	};
}

function toWorkspaceChunk(row: WorkspaceChunkRow): WorkspaceChunk {
	return {
		id: row.id,
		chunk_id: row.chunk_id,
		resource_id: row.resource_id,
		version_id: row.version_id,
		workspace_id: row.workspace_id,
		chunk_index: row.chunk_index,
		chunk_count: row.chunk_count,
		start_position: row.start_position,
		end_position: row.end_position,
		content: row.content,
		content_hash: row.content_hash,
		embedding: bufferToFloatArray(row.embedding),
		embedding_model: row.embedding_model ?? undefined,
		embedding_dimensions: row.embedding_dimensions ?? undefined,
		embedding_updated_at: row.embedding_updated_at ?? undefined,
	};
}

function toWorkspaceReferenceEdge(row: WorkspaceReferenceEdgeRow): WorkspaceReferenceEdge {
	return {
		id: row.id,
		workspace_id: row.workspace_id,
		source_resource_id: row.source_resource_id,
		source_version_id: row.source_version_id,
		target_resource_id: row.target_resource_id,
		target_version_id: row.target_version_id,
		edge_type: row.edge_type as WorkspaceEdgeType,
		quote: row.quote,
		created_at: row.created_at,
	};
}

function toWorkspaceJob(row: WorkspaceJobRow): WorkspaceJob {
	return {
		id: row.id,
		workspace_id: row.workspace_id,
		kind: row.kind as WorkspaceJob["kind"],
		status: row.status as WorkspaceIndexStatus,
		total: row.total,
		done: row.done,
		error: row.error,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function currentUnixSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Local copies of `parseJson` / `stringifyJson` from
 * `packages/sqlite/src/raw-message-manager.ts:180-196`. Those helpers
 * are not exported from `@melandlabs/sqlite`, so the workspace
 * package keeps its own copy in scope. Behaviour matches the memory
 * store: missing / invalid JSON falls back to the caller-provided
 * default rather than throwing.
 */
function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function stringifyJson(value: unknown): string | null {
	if (value === undefined) return null;
	return JSON.stringify(value);
}

/**
 * Resolve the SQLite DB file path that backs the workspace store.
 * Mirrors `packages/memory-store/src/storage/sqlite-raw-message-store.ts:27-31`
 * so the workspace tables live in the same file as the rest of the
 * memory store (no separate DB to coordinate backups / migrations).
 */
export function resolveWorkspaceDbPath(dbPath?: string): string {
	if (dbPath && dbPath.length > 0) return dbPath;
	const fromEnv = process.env.MEMORY_STORE_DB_PATH?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : getOpenContextPath("memory", "store.db");
}

export interface SqliteWorkspaceStoreOptions {
	dbPath?: string;
	db?: DatabaseLike;
	/**
	 * Lazily import a custom embedding function. Tests inject a deterministic
	 * mock here to avoid hitting OpenRouter; production leaves this unset
	 * and uses `@melandlabs/rag`'s `generateEmbeddings` directly.
	 */
	embeddingQueueFactory?: (store: SqliteWorkspaceStore) => {
		enqueue(input: { resource_id: number; version_id: number; jobId?: number }): Promise<void>;
		drain(): Promise<void>;
	};
}

/**
 * Lightweight stub interface that `EmbeddingQueue` consumes via duck typing
 * (`store.fetchPendingChunks`, `store.writeChunkEmbeddings`, …). Keeping it
 * here (rather than re-importing the queue file) avoids a circular type
 * reference between `embedding-queue.ts` and `sqlite.ts`.
 */
export interface SqliteWorkspaceStore {
	readonly __testDb: DatabaseLike;
	init(): Promise<void>;
	close(): Promise<void>;

	fetchPendingChunks(versionId: number, limit: number): Array<WorkspaceChunkRow>;
	writeChunkEmbeddings(
		entries: Array<{ chunkId: string; embedding: number[] }>,
		model: string,
		dimensions: number,
	): void;
	ensureChildVectorTable(dimensions: number): void;
	markVersionEmbeddingReady(resourceId: number, versionId: number): void;
	markVersionEmbeddingPartial(resourceId: number, versionId: number, errorMessage: string): void;
	markVersionEmbeddingFailed(resourceId: number, versionId: number, errorMessage: string): void;
	markJobFailed(jobId: number | null, errorMessage: string): void;
	completeJob(jobId: number, done: number): void;

	indexResource(input: {
		workspace_id: string;
		user_id: string;
		resource: OkfFolderResource;
	}): Promise<{ resource_id: number; version_id: number; change_kind: WorkspaceResourceVersion["change_kind"] }>;

	upsertReferenceEdges(input: {
		workspace_id: string;
		edges: Array<{
			source_resource_id: number;
			source_version_id: number | null;
			target_resource_id: number;
			target_version_id: number | null;
			edge_type: WorkspaceEdgeType;
			quote?: string | null;
		}>;
	}): void;

	softDeleteMissingResources(input: {
		workspace_id: string;
		presentKeys: Set<string>;
	}): Array<{ canonical_key: string }>;

	listResources(input: ListWorkspaceResourcesInput): ListWorkspaceResourcesResult;

	searchLexical(input: {
		workspace_id: string;
		user_id: string;
		query: string;
		resource_types?: string[];
		limit: number;
	}): WorkspaceSearchHit[];

	searchSemantic(input: {
		workspace_id: string;
		user_id: string;
		queryEmbedding: number[];
		resource_types?: string[];
		limit: number;
		threshold: number;
	}): WorkspaceSearchHit[];

	expandNeighbors(input: {
		workspace_id: string;
		hits: WorkspaceSearchHit[];
		hops: 1 | 2;
		limit: number;
	}): WorkspaceSearchHit[];

	findResourceByCanonicalKey(input: { workspace_id: string; canonical_key: string }): WorkspaceResource | null;

	createJob(input: { workspace_id: string; kind: WorkspaceJob["kind"]; total: number }): WorkspaceJob;
	updateJobTotal(jobId: number, total: number): void;
}

/**
 * `SqliteWorkspaceStore` — full implementation. The class body is split
 * into clearly labelled sections (`init/close`, `index pipeline`,
 * `search pipeline`, `cross-file expansion`) to keep the file readable
 * when each section grows in later phases.
 */
export class SqliteWorkspaceStore implements SqliteWorkspaceStore {
	readonly __testDb!: DatabaseLike;
	private readonly db: DatabaseLike;
	private readonly ownsConnection: boolean;
	private readonly embeddingQueueFactory?: SqliteWorkspaceStoreOptions["embeddingQueueFactory"];
	private initialized = false;
	private vectorSearchAvailable = false;

	constructor(options: SqliteWorkspaceStoreOptions | string = ":memory:") {
		if (typeof options === "string") {
			this.db = new Database(options);
			this.ownsConnection = true;
			this.embeddingQueueFactory = undefined;
		} else if (options.db) {
			this.db = options.db;
			this.ownsConnection = false;
			this.embeddingQueueFactory = options.embeddingQueueFactory;
		} else {
			this.db = new Database(options.dbPath ?? ":memory:");
			this.ownsConnection = true;
			this.embeddingQueueFactory = options.embeddingQueueFactory;
		}
		// `__testDb` is intentionally a public readonly handle (mirrors
		// `SQLiteVsaStore.__testDb`). Assigning it through `this.__testDb`
		// in a `readonly` declaration trips the DTS build's strictness,
		// so we set it via `Object.defineProperty` here. This is only
		// touched in tests — production code goes through the typed
		// surface above.
		Object.defineProperty(this, "__testDb", { value: this.db, writable: false, enumerable: true });
	}

	async init(): Promise<void> {
		if (this.initialized) return;
		initializeWorkspaceSchema(this.db);
		// Load sqlite-vec into this connection so vec0 tables can be
		// created/queried. Mirrors `SQLiteRawMessageManager.initializeVectorSearch`
		// (`packages/sqlite/src/raw-message-manager.ts:1683-1695`). If the
		// extension can't load (e.g. the binary wasn't built for the host
		// platform) we leave `vectorSearchAvailable = false` so the
		// embedding fan-out degrades to lexical-only instead of crashing.
		try {
			sqliteVec.load(this.db);
			this.vectorSearchAvailable = true;
		} catch {
			this.vectorSearchAvailable = false;
		}
		this.initialized = true;
	}

		async close(): Promise<void> {
		// Best-effort: drop the singleton reference and let the OS reap the
		// native handle on process exit. `db.close()` is intentionally NOT
		// called here because `sqlite-vec`'s native destructor occasionally
		// raises SIGABRT during process teardown on macOS, which would
		// surface to the user as a confusing abort right after we've
		// already printed the search result. The trade-off is that the
		// process exit takes a few extra ms (sqlite writes its WAL flush)
		// but no abort noise.
		this.initialized = false;
		if (!this.ownsConnection) return;
		// We intentionally do NOT call `this.db.close()` — see comment above.
		// Tests that need a clean teardown should use `__resetSQLiteWorkspaceStoreForTests`.
	}

	// -------------------------------------------------------------------------
	// Vector table helpers (mirrors raw-message-manager.ts:1859-1914)
	// -------------------------------------------------------------------------

	private getChildVectorTableName(dimensions: number): string {
		if (!Number.isInteger(dimensions) || dimensions <= 0) {
			throw new Error(`Invalid project chunk embedding dimensions: ${dimensions}`);
		}
		return `workspace_chunks_vec_d${dimensions}`;
	}

	ensureChildVectorTable(dimensions: number): void {
		if (!this.vectorSearchAvailable) {
			// sqlite-vec didn't load — skip vec0 creation. The embedding
			// queue's `writeChunkEmbeddings` will still persist the raw
			// vector into `workspace_chunks.embedding` for later replay
			// once the extension is available, and semantic search will
			// fall back to lexical.
			return;
		}
		const tableName = this.getChildVectorTableName(dimensions);
		this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName}
      USING vec0(
        embedding float[${dimensions}],
        chunk_id TEXT PRIMARY KEY
      );
    `);
	}

	private listChildVectorTables(): string[] {
		return (
			this.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'workspace_chunks_vec_d%'",
				)
				.all() as Array<{ name: string }>
		)
			.map((row) => row.name)
			.filter((name) => /^workspace_chunks_vec_d\d+$/.test(name));
	}

	// -------------------------------------------------------------------------
	// Embedding queue helpers
	// -------------------------------------------------------------------------

	fetchPendingChunks(versionId: number, limit: number): Array<WorkspaceChunkRow> {
		return this.db
			.prepare(
				`SELECT id, chunk_id, resource_id, version_id, workspace_id, chunk_index, chunk_count,
                        start_position, end_position, content, content_hash,
                        embedding, embedding_model, embedding_dimensions, embedding_updated_at
                 FROM workspace_chunks
                 WHERE version_id = ? AND embedding IS NULL
                 ORDER BY chunk_index
                 LIMIT ?`,
			)
			.all(versionId, limit) as Array<WorkspaceChunkRow>;
	}

	writeChunkEmbeddings(
		entries: Array<{ chunkId: string; embedding: number[] }>,
		model: string,
		dimensions: number,
	): void {
		if (entries.length === 0) return;
		const writeVec = this.vectorSearchAvailable;
		const dimensionsTable = this.getChildVectorTableName(dimensions);
		this.db.exec("BEGIN");
		try {
			const updateStmt = this.db.prepare(
				`UPDATE workspace_chunks
                 SET embedding = ?, embedding_model = ?, embedding_dimensions = ?, embedding_updated_at = ?
                 WHERE chunk_id = ?`,
			);
			const insertVecStmt = writeVec
				? this.db.prepare(
						`INSERT OR REPLACE INTO ${dimensionsTable}(embedding, chunk_id) VALUES (?, ?)`,
					)
				: null;
			const now = currentUnixSeconds();
			for (const entry of entries) {
				const buffer = floatArrayToBuffer(entry.embedding);
				updateStmt.run(buffer, model, dimensions, now, entry.chunkId);
				if (writeVec && buffer && insertVecStmt) insertVecStmt.run(buffer, entry.chunkId);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	markVersionEmbeddingReady(resourceId: number, versionId: number): void {
		const stillMissing = this.db
			.prepare(`SELECT 1 FROM workspace_chunks WHERE version_id = ? AND embedding IS NULL LIMIT 1`)
			.get(versionId);
		if (stillMissing) {
			this.db
				.prepare(`UPDATE workspace_resources SET index_status = 'partial' WHERE id = ?`)
				.run(resourceId);
			return;
		}
		this.db
			.prepare(`UPDATE workspace_resources SET index_status = 'ready' WHERE id = ?`)
			.run(resourceId);
	}

	markVersionEmbeddingPartial(resourceId: number, versionId: number, errorMessage: string): void {
		// `versionId` and `errorMessage` are reserved for a future
		// per-version error column on `workspace_jobs`. For now we just
		// flip the resource status to `partial` so callers can see the
		// resource is half-indexed.
		void versionId;
		void errorMessage;
		this.db
			.prepare(`UPDATE workspace_resources SET index_status = 'partial' WHERE id = ?`)
			.run(resourceId);
	}

	markVersionEmbeddingFailed(resourceId: number, versionId: number, errorMessage: string): void {
		// Same reservation as `markVersionEmbeddingPartial`. Future phases
		// will surface the error string on the resource / version row.
		void versionId;
		void errorMessage;
		this.db
			.prepare(`UPDATE workspace_resources SET index_status = 'failed' WHERE id = ?`)
			.run(resourceId);
	}

	markJobFailed(jobId: number | null, errorMessage: string): void {
		if (jobId === null) return;
		this.db
			.prepare(`UPDATE workspace_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
			.run(errorMessage, currentUnixSeconds(), jobId);
	}

	completeJob(jobId: number, done: number): void {
		this.db
			.prepare(`UPDATE workspace_jobs SET status = 'ready', done = ?, updated_at = ? WHERE id = ?`)
			.run(done, currentUnixSeconds(), jobId);
	}

	// -------------------------------------------------------------------------
	// Indexing pipeline (sync portion — embedding fan-out is enqueued separately)
	// -------------------------------------------------------------------------

	async indexResource(input: {
		workspace_id: string;
		user_id: string;
		resource: OkfFolderResource;
	}): Promise<{ resource_id: number; version_id: number; change_kind: WorkspaceResourceVersion["change_kind"] }> {
		await this.init();
		const { workspace_id, user_id, resource } = input;
		const now = currentUnixSeconds();
		const contentHash = sha256(resource.body);

		const tx = this.db.transaction(() => {
			const existing = this.db
				.prepare(
					`SELECT id, current_version_id
                     FROM workspace_resources
                     WHERE workspace_id = ? AND canonical_key = ?`,
				)
				.get(workspace_id, resource.canonical_key) as { id: number; current_version_id: number | null } | undefined;

			let resourceId: number;
			let currentVersionId: number | null = existing?.current_version_id ?? null;
			let changeKind: WorkspaceResourceVersion["change_kind"];

			if (!existing) {
				const insertResource = this.db
					.prepare(
						`INSERT INTO workspace_resources(
                            workspace_id, user_id, resource_type, canonical_key, title, storage_kind,
                            current_version_id, index_status, created_at, updated_at, metadata
                         ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?)`,
					)
					.run(
						workspace_id,
						user_id,
						resource.resource_type,
						resource.canonical_key,
						resource.title,
						"okf_local_dir",
						now,
						now,
						stringifyJson(resource.front_matter),
					);
				resourceId = Number(insertResource.lastInsertRowid);
				changeKind = "created";
			} else {
				resourceId = existing.id;
				if (currentVersionId !== null) {
					const prevVersion = this.db
						.prepare(
							`SELECT sha256 FROM workspace_resource_versions WHERE id = ?`,
						)
						.get(currentVersionId) as { sha256: string } | undefined;
					if (prevVersion?.sha256 === contentHash) {
						changeKind = "unchanged";
						// Touch updated_at so the resource stays "fresh" without
						// re-indexing — callers may want to detect staleness
						// via `updated_at` vs. `current_version_id.created_at`.
						this.db
							.prepare(`UPDATE workspace_resources SET updated_at = ? WHERE id = ?`)
							.run(now, resourceId);
						return { resource_id: resourceId, version_id: currentVersionId, change_kind: changeKind };
					}
				}
				changeKind = "modified";
			}

			const maxVersion = this.db
				.prepare(
					`SELECT COALESCE(MAX(version_number), 0) AS max_version
                     FROM workspace_resource_versions WHERE resource_id = ?`,
				)
				.get(resourceId) as { max_version: number };

			const insertVersion = this.db
				.prepare(
					`INSERT INTO workspace_resource_versions(
                        resource_id, version_number, sha256, change_kind, size_bytes,
                        parent_version_id, source_path, created_at, metadata
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					resourceId,
					maxVersion.max_version + 1,
					contentHash,
					changeKind,
					resource.size_bytes,
					currentVersionId,
					resource.absolute_path,
					now,
					stringifyJson(resource.front_matter),
				);
			const versionId = Number(insertVersion.lastInsertRowid);

			// Delete any old chunks for this resource; FTS5 mirror is
			// kept in sync via the AI/AD/AU triggers.
			this.db.prepare(`DELETE FROM workspace_chunks WHERE resource_id = ?`).run(resourceId);

			const pieces = chunkTextByEstimatedTokens(resource.body, {
				maxTokens: RAW_MESSAGE_CHUNK_MAX_TOKENS,
				overlapTokens: RAW_MESSAGE_CHUNK_OVERLAP_TOKENS,
			});
			const chunkCount = pieces.length;
			const insertChunk = this.db.prepare(
				`INSERT INTO workspace_chunks(
                    chunk_id, resource_id, version_id, workspace_id, chunk_index, chunk_count,
                    start_position, end_position, content, content_hash
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const piece of pieces) {
				const pieceHash = sha256(piece.content);
				const chunkId = `${workspace_id}:${resourceId}:${versionId}:chunk:${piece.chunkIndex}:${pieceHash.slice(0, 16)}`;
				insertChunk.run(
					chunkId,
					resourceId,
					versionId,
					workspace_id,
					piece.chunkIndex,
					chunkCount,
					piece.startPosition,
					piece.endPosition,
					piece.content,
					pieceHash,
				);
			}

			this.db
				.prepare(
					`UPDATE workspace_resources
                     SET current_version_id = ?, index_status = 'pending', updated_at = ?, title = ?
                     WHERE id = ?`,
				)
				.run(versionId, now, resource.title, resourceId);

			currentVersionId = versionId;
			return { resource_id: resourceId, version_id: versionId, change_kind: changeKind };
		});

		const result = tx();
		return result;
	}

	// -------------------------------------------------------------------------
	// Reference edges
	// -------------------------------------------------------------------------

	upsertReferenceEdges(input: {
		workspace_id: string;
		edges: Array<{
			source_resource_id: number;
			source_version_id: number | null;
			target_resource_id: number;
			target_version_id: number | null;
			edge_type: WorkspaceEdgeType;
			quote?: string | null;
		}>;
	}): void {
		const now = currentUnixSeconds();
		const tx = this.db.transaction(() => {
			const insertStmt = this.db.prepare(
				`INSERT INTO workspace_reference_edges(
                    workspace_id, source_resource_id, source_version_id,
                    target_resource_id, target_version_id, edge_type, quote, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(workspace_id, source_resource_id, target_resource_id, edge_type) DO UPDATE SET
                    source_version_id = excluded.source_version_id,
                    target_version_id = excluded.target_version_id,
                    quote = excluded.quote`,
			);
			for (const edge of input.edges) {
				insertStmt.run(
					input.workspace_id,
					edge.source_resource_id,
					edge.source_version_id,
					edge.target_resource_id,
					edge.target_version_id,
					edge.edge_type,
					edge.quote ?? null,
					now,
				);
			}
		});
		tx();
	}

	// -------------------------------------------------------------------------
	// Resource listing
	// -------------------------------------------------------------------------

	listResources(input: ListWorkspaceResourcesInput): ListWorkspaceResourcesResult {
		const where: string[] = ["workspace_id = ?"];
		const params: Array<string | number> = [input.workspace_id];
		if (input.resource_type) {
			where.push("resource_type = ?");
			params.push(input.resource_type);
		}
		if (input.index_status) {
			where.push("index_status = ?");
			params.push(input.index_status);
		}
		const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
		const offset = Math.max(0, Math.floor(input.offset ?? 0));
		const rows = this.db
			.prepare(
				`SELECT * FROM workspace_resources
                 WHERE ${where.join(" AND ")}
                 ORDER BY updated_at DESC, id DESC
                 LIMIT ? OFFSET ?`,
			)
			.all(...params, limit, offset) as Array<WorkspaceResourceRow>;
		const totalRow = this.db
			.prepare(`SELECT COUNT(*) AS total FROM workspace_resources WHERE ${where.join(" AND ")}`)
			.get(...params) as { total: number };
		return {
			total: totalRow.total,
			resources: rows.map(toWorkspaceResource),
		};
	}

	findResourceByCanonicalKey(input: { workspace_id: string; canonical_key: string }): WorkspaceResource | null {
		const row = this.db
			.prepare(`SELECT * FROM workspace_resources WHERE workspace_id = ? AND canonical_key = ?`)
			.get(input.workspace_id, input.canonical_key) as WorkspaceResourceRow | undefined;
		return row ? toWorkspaceResource(row) : null;
	}

	// -------------------------------------------------------------------------
	// Search: lexical
	// -------------------------------------------------------------------------

	searchLexical(input: {
		workspace_id: string;
		user_id: string;
		query: string;
		resource_types?: string[];
		limit: number;
	}): WorkspaceSearchHit[] {
		void input.user_id;
		const keywords = tokenizeQuery(input.query);
		if (keywords.length === 0) return [];
		const ftsQuery = keywords.map((kw) => `"${kw.replace(/"/g, '""')}"`).join(" OR ");
		const params: Array<string | number> = [];
		let resourceTypeFilter = "";
		if (input.resource_types && input.resource_types.length > 0) {
			resourceTypeFilter = `AND pr.resource_type IN (${input.resource_types.map(() => "?").join(",")})`;
			params.push(...input.resource_types);
		}
		const sql = `
            SELECT pc.chunk_id,
                   pc.resource_id,
                   pc.version_id,
                   pr.resource_type,
                   pr.title         AS resource_title,
                   pr.canonical_key,
                   pc.content,
                   bm25(workspace_chunks_fts) AS bm25_score,
                   pc.chunk_index
            FROM workspace_chunks_fts fts
            JOIN workspace_chunks pc ON pc.id = fts.rowid
            JOIN workspace_resources pr ON pr.id = pc.resource_id
            WHERE workspace_chunks_fts MATCH ?
              AND pc.workspace_id = ?
              ${resourceTypeFilter}
            ORDER BY bm25_score ASC
            LIMIT ?
        `;
		params.unshift(ftsQuery, input.workspace_id, input.limit);
		const rows = this.db.prepare(sql).all(...params) as Array<{
			chunk_id: string;
			resource_id: number;
			version_id: number;
			resource_type: string;
			resource_title: string;
			canonical_key: string;
			content: string;
			bm25_score: number;
			chunk_index: number;
		}>;
		return rows.map((row) => ({
			chunk_id: row.chunk_id,
			resource_id: row.resource_id,
			version_id: row.version_id,
			resource_type: row.resource_type,
			resource_title: row.resource_title,
			canonical_key: row.canonical_key,
			snippet: buildSnippet(row.content, keywords),
			matched_terms: keywords,
			score: bm25ToSimilarity(row.bm25_score),
			signals: { lexical: bm25ToSimilarity(row.bm25_score) },
			reference_edges: this.edgesForResource(row.resource_id),
		}));
	}

	// -------------------------------------------------------------------------
	// Search: semantic (sqlite-vec KNN, widen-and-retry)
	// -------------------------------------------------------------------------

	searchSemantic(input: {
		workspace_id: string;
		user_id: string;
		queryEmbedding: number[];
		resource_types?: string[];
		limit: number;
		threshold: number;
	}): WorkspaceSearchHit[] {
		void input.user_id;
		const tableName = this.getChildVectorTableName(input.queryEmbedding.length);
		if (!this.childVectorTableExists(tableName)) {
			// No embeddings written yet — caller should fall back to lexical.
			return [];
		}
		const scanLimit = Math.max(input.limit, input.limit * 4);
		const vecKnnMaxK = 4096;
		let currentScanLimit = scanLimit;
		while (true) {
			const vecRows = this.db
				.prepare(
					`SELECT chunk_id, distance
                     FROM ${tableName}
                     WHERE embedding MATCH ?
                     ORDER BY distance
                     LIMIT ?`,
				)
				.all(floatArrayToBuffer(input.queryEmbedding), currentScanLimit) as Array<{
				chunk_id: string;
				distance: number;
			}>;
			if (vecRows.length === 0) return [];
			const resourceTypeFilter =
				input.resource_types && input.resource_types.length > 0
					? `AND pr.resource_type IN (${input.resource_types.map(() => "?").join(",")})`
					: "";
			const params: Array<string | number> = [input.workspace_id, ...vecRows.map((r) => r.chunk_id)];
			if (input.resource_types && input.resource_types.length > 0) {
				params.push(...input.resource_types);
			}
			params.push(input.limit);
			const hydrated = this.db
				.prepare(
					`SELECT pc.chunk_id,
                            pc.resource_id,
                            pc.version_id,
                            pr.resource_type,
                            pr.title         AS resource_title,
                            pr.canonical_key,
                            pc.content
                     FROM workspace_chunks pc
                     JOIN workspace_resources pr ON pr.id = pc.resource_id
                     WHERE pc.workspace_id = ?
                       AND pc.chunk_id IN (${vecRows.map(() => "?").join(",")})
                       ${resourceTypeFilter}
                     ORDER BY pc.id ASC
                     LIMIT ?`,
				)
				.all(...params) as Array<{
				chunk_id: string;
				resource_id: number;
				version_id: number;
				resource_type: string;
				resource_title: string;
				canonical_key: string;
				content: string;
			}>;
			const byDistance = new Map(vecRows.map((row) => [row.chunk_id, row.distance]));
			const candidateHits: WorkspaceSearchHit[] = [];
			for (const row of hydrated) {
				const distance = byDistance.get(row.chunk_id) ?? Number.POSITIVE_INFINITY;
				const similarity = sqliteDistanceToSimilarity(distance);
				if (similarity < input.threshold) continue;
				candidateHits.push({
					chunk_id: row.chunk_id,
					resource_id: row.resource_id,
					version_id: row.version_id,
					resource_type: row.resource_type,
					resource_title: row.resource_title,
					canonical_key: row.canonical_key,
					snippet: buildSnippet(row.content, []),
					matched_terms: [],
					score: similarity,
					signals: { semantic: similarity },
					reference_edges: this.edgesForResource(row.resource_id),
				});
			}
			const hits = candidateHits.sort((a, b) => b.score - a.score);
			if (hits.length >= input.limit || vecRows.length < currentScanLimit) {
				return hits.slice(0, input.limit);
			}
			if (currentScanLimit >= vecKnnMaxK) {
				return hits.slice(0, input.limit);
			}
			currentScanLimit = Math.min(currentScanLimit * 2, vecKnnMaxK);
		}
	}

	private childVectorTableExists(name: string): boolean {
		if (!this.vectorSearchAvailable) return false;
		return Boolean(
			this.db
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
				.get(name),
		);
	}

	// -------------------------------------------------------------------------
	// Cross-file expansion (BFS over workspace_reference_edges)
	// -------------------------------------------------------------------------

	expandNeighbors(input: {
		workspace_id: string;
		hits: WorkspaceSearchHit[];
		hops: 1 | 2;
		limit: number;
	}): WorkspaceSearchHit[] {
		if (input.hits.length === 0) return input.hits.slice(0, input.limit);
		const visited = new Set<number>(input.hits.map((h) => h.resource_id));
		const queue: Array<{ resource_id: number; depth: number }> = input.hits.map((h) => ({
			resource_id: h.resource_id,
			depth: 0,
		}));
		const expansions: WorkspaceSearchHit[] = [];
		const edgeBoost = (resourceId: number): number => {
			const out = this.db
				.prepare(
					`SELECT COUNT(*) AS c FROM workspace_reference_edges
                     WHERE workspace_id = ? AND source_resource_id = ?`,
				)
				.get(input.workspace_id, resourceId) as { c: number };
			const inc = this.db
				.prepare(
					`SELECT COUNT(*) AS c FROM workspace_reference_edges
                     WHERE workspace_id = ? AND target_resource_id = ?`,
				)
				.get(input.workspace_id, resourceId) as { c: number };
			return 0.1 * (out.c + inc.c);
		};
		while (queue.length > 0 && expansions.length < input.limit * 2) {
			const head = queue.shift();
			if (!head) break;
			if (head.depth >= input.hops) continue;
			const neighborIds = this.db
				.prepare(
					`SELECT DISTINCT target_resource_id AS id FROM workspace_reference_edges
                     WHERE workspace_id = ? AND source_resource_id = ?
                     UNION
                     SELECT DISTINCT source_resource_id AS id FROM workspace_reference_edges
                     WHERE workspace_id = ? AND target_resource_id = ?`,
				)
				.all(input.workspace_id, head.resource_id, input.workspace_id, head.resource_id) as Array<{
				id: number;
			}>;
			for (const { id } of neighborIds) {
				if (visited.has(id)) continue;
				visited.add(id);
				const boost = edgeBoost(id);
				const chunkRow = this.db
					.prepare(
						`SELECT pc.chunk_id, pc.resource_id, pc.version_id, pc.content, pc.chunk_index,
                                pr.resource_type, pr.title AS resource_title, pr.canonical_key
                         FROM workspace_chunks pc
                         JOIN workspace_resources pr ON pr.id = pc.resource_id
                         WHERE pc.resource_id = ?
                         ORDER BY pc.chunk_index ASC
                         LIMIT 1`,
					)
					.get(id) as
					| {
							chunk_id: string;
							resource_id: number;
							version_id: number;
							content: string;
							chunk_index: number;
							resource_type: string;
							resource_title: string;
							canonical_key: string;
					  }
					| undefined;
				if (!chunkRow) continue;
				expansions.push({
					chunk_id: chunkRow.chunk_id,
					resource_id: chunkRow.resource_id,
					version_id: chunkRow.version_id,
					resource_type: chunkRow.resource_type,
					resource_title: chunkRow.resource_title,
					canonical_key: chunkRow.canonical_key,
					snippet: buildSnippet(chunkRow.content, []),
					matched_terms: [],
					score: boost,
					signals: { edge_boost: boost },
					reference_edges: this.edgesForResource(chunkRow.resource_id),
				});
				queue.push({ resource_id: id, depth: head.depth + 1 });
			}
		}
		const seen = new Set<number>(input.hits.map((h) => h.resource_id));
		const dedupedExpansions: WorkspaceSearchHit[] = [];
		for (const expansion of expansions) {
			if (seen.has(expansion.resource_id)) continue;
			seen.add(expansion.resource_id);
			dedupedExpansions.push(expansion);
		}
		const merged = [...input.hits, ...dedupedExpansions]
			.sort((a, b) => b.score - a.score)
			.slice(0, input.limit);
		return merged;
	}

	private edgesForResource(resourceId: number): WorkspaceSearchHit["reference_edges"] {
		const rows = this.db
			.prepare(
				`SELECT edge_type, target_resource_id FROM workspace_reference_edges
                 WHERE source_resource_id = ? OR target_resource_id = ?
                 LIMIT 16`,
			)
			.all(resourceId, resourceId) as Array<{ edge_type: WorkspaceEdgeType; target_resource_id: number }>;
		return rows;
	}

	// -------------------------------------------------------------------------
	// Soft-delete
	// -------------------------------------------------------------------------

	softDeleteMissingResources(input: {
		workspace_id: string;
		presentKeys: Set<string>;
	}): Array<{ canonical_key: string }> {
		const allRows = this.db
			.prepare(`SELECT id, canonical_key, metadata FROM workspace_resources WHERE workspace_id = ?`)
			.all(input.workspace_id) as Array<{ id: number; canonical_key: string; metadata: string | null }>;
		const missing: Array<{ canonical_key: string }> = [];
		const now = currentUnixSeconds();
		for (const row of allRows) {
			if (input.presentKeys.has(row.canonical_key)) continue;
			const meta = parseJson<Record<string, unknown>>(row.metadata, {}) ?? {};
			if (meta.deleted_at) continue;
			meta.deleted_at = now;
			this.db
				.prepare(`UPDATE workspace_resources SET metadata = ?, updated_at = ? WHERE id = ?`)
				.run(stringifyJson(meta), now, row.id);
			missing.push({ canonical_key: row.canonical_key });
		}
		return missing;
	}

	// -------------------------------------------------------------------------
	// Job helpers (used by okf-backend + tests)
	// -------------------------------------------------------------------------

	createJob(input: { workspace_id: string; kind: WorkspaceJob["kind"]; total: number }): WorkspaceJob {
		const now = currentUnixSeconds();
		const stmt = this.db
			.prepare(
				`INSERT INTO workspace_jobs(workspace_id, kind, status, total, done, created_at, updated_at)
                 VALUES (?, ?, 'pending', ?, 0, ?, ?)`,
			)
			.run(input.workspace_id, input.kind, input.total, now, now);
		const row = this.db
			.prepare(`SELECT * FROM workspace_jobs WHERE id = ?`)
			.get(Number(stmt.lastInsertRowid)) as WorkspaceJobRow;
		return toWorkspaceJob(row);
	}

	updateJobTotal(jobId: number, total: number): void {
		this.db
			.prepare(`UPDATE workspace_jobs SET total = ?, updated_at = ? WHERE id = ?`)
			.run(total, currentUnixSeconds(), jobId);
	}
}

function tokenizeQuery(query: string): string[] {
	return query
		.split(/\s+/u)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

function buildSnippet(content: string, keywords: string[]): string {
	const max = 160;
	if (content.length <= max) return content;
	if (keywords.length === 0) return `${content.slice(0, max)}…`;
	const lower = content.toLowerCase();
	for (const keyword of keywords) {
		const idx = lower.indexOf(keyword.toLowerCase());
		if (idx >= 0) {
			const start = Math.max(0, idx - 40);
			const end = Math.min(content.length, idx + keyword.length + 120);
			return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
		}
	}
	return `${content.slice(0, max)}…`;
}

function bm25ToSimilarity(score: number): number {
	if (!Number.isFinite(score)) return 0;
	// bm25() returns negative numbers in SQLite FTS5; lower = better.
	const normalised = 1 / (1 + Math.abs(score));
	return Math.min(1, Math.max(0, normalised));
}

function sqliteDistanceToSimilarity(distance: number): number {
	if (!Number.isFinite(distance)) return 0;
	// sqlite-vec returns L2 distance. Embeddings are L2-normalised upstream
	// (the same assumption `sqliteVectorDistanceToCosineSimilarity` makes in
	// `packages/sqlite/src/raw-message-manager.ts`), so the conversion is
	// the standard `cosine_similarity = 1 - distance^2 / 2` clamped to [-1, 1].
	return Math.max(-1, 1 - (distance * distance) / 2);
}

// -------------------------------------------------------------------------
// Singleton accessor
// -------------------------------------------------------------------------

let _instance: SqliteWorkspaceStore | undefined;

export async function getSQLiteWorkspaceStore(
	options: SqliteWorkspaceStoreOptions = {},
): Promise<SqliteWorkspaceStore> {
	if (!_instance) {
		const dbPath = options.dbPath ?? resolveWorkspaceDbPath();
		mkdirSync(dirname(dbPath), { recursive: true });
		const instance = new SqliteWorkspaceStore({ ...options, dbPath });
		await instance.init();
		_instance = instance;
	}
	return _instance;
}

export async function closeSQLiteWorkspaceStore(): Promise<void> {
	if (!_instance) return;
	await _instance.close();
	_instance = undefined;
}

/** Test-only reset hook; mirrors `__resetSQLiteRawMessageManagerForTests`. */
export function __resetSQLiteWorkspaceStoreForTests(): void {
	_instance = undefined;
}

/**
 * Build a `SqliteWorkspaceStore` from an existing in-memory database handle.
 * Convenience for tests that want to share a single connection with the
 * raw-message store (e.g. to verify FK / multi-table integration).
 */
export async function createSqliteWorkspaceStore(
	options: SqliteWorkspaceStoreOptions = {},
): Promise<SqliteWorkspaceStore> {
	const instance = new SqliteWorkspaceStore(options);
	await instance.init();
	return instance;
}

// -------------------------------------------------------------------------
// Public helpers exported for the API layer (api.ts) and OKF backend.
// -------------------------------------------------------------------------

export async function runUpdateWorkspaceContext(
	store: SqliteWorkspaceStore,
	input: UpdateWorkspaceContextInput & { user_id: string },
	hooks: {
		indexOkfFolder: (
			workspace_id: string,
			user_id: string,
			path: string,
		) => Promise<UpdateWorkspaceContextResult>;
	},
): Promise<UpdateWorkspaceContextResult> {
	return hooks.indexOkfFolder(input.workspace_id, input.user_id, input.path);
}

export async function runSearchWorkspaceContext(
	store: SqliteWorkspaceStore,
	input: SearchWorkspaceContextInput & { user_id: string },
	hooks: {
		searchLexical: (
			workspace_id: string,
			user_id: string,
			query: string,
			resource_types?: string[],
			limit?: number,
		) => WorkspaceSearchHit[];
		searchSemantic: (
			workspace_id: string,
			user_id: string,
			queryEmbedding: number[],
			resource_types?: string[],
			limit?: number,
			threshold?: number,
		) => WorkspaceSearchHit[];
		expandNeighbors: (
			workspace_id: string,
			hits: WorkspaceSearchHit[],
			hops: 1 | 2,
			limit: number,
		) => WorkspaceSearchHit[];
		generateEmbedding?: (text: string) => Promise<number[]>;
		fuse?: (lexical: WorkspaceSearchHit[], semantic: WorkspaceSearchHit[], limit: number) => WorkspaceSearchHit[];
	},
): Promise<SearchWorkspaceContextResult> {
	const strategy: WorkspaceSearchStrategy = input.strategy ?? "hybrid";
	const options = input.options ?? {};
	const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
	const threshold = options.threshold ?? 0.7;
	const resourceTypes = options.resource_types;

	let hits: WorkspaceSearchHit[] = [];
	if (strategy === "lexical") {
		hits = hooks.searchLexical(input.workspace_id, input.user_id, input.query, resourceTypes, limit);
	} else if (strategy === "semantic") {
		if (!hooks.generateEmbedding) {
			hits = [];
		} else {
			const embedding = await hooks.generateEmbedding(input.query);
			hits = hooks.searchSemantic(
				input.workspace_id,
				input.user_id,
				embedding,
				resourceTypes,
				limit,
				threshold,
			);
			if (hits.length === 0) {
				// Semantic fallback to lexical so users still get a hit
				// before embeddings are written.
				hits = hooks.searchLexical(input.workspace_id, input.user_id, input.query, resourceTypes, limit);
			}
		}
	} else if (strategy === "hybrid") {
		const candidateLimit = limit * 4;
		const lexicalHits = hooks.searchLexical(
			input.workspace_id,
			input.user_id,
			input.query,
			resourceTypes,
			candidateLimit,
		);
		let semanticHits: WorkspaceSearchHit[] = [];
		if (hooks.generateEmbedding) {
			const embedding = await hooks.generateEmbedding(input.query);
			semanticHits = hooks.searchSemantic(
				input.workspace_id,
				input.user_id,
				embedding,
				resourceTypes,
				candidateLimit,
				threshold,
			);
		}
		hits = hooks.fuse ? hooks.fuse(lexicalHits, semanticHits, limit) : lexicalHits.slice(0, limit);
	} else {
		const candidateLimit = limit * 4;
		const lexicalHits = hooks.searchLexical(
			input.workspace_id,
			input.user_id,
			input.query,
			resourceTypes,
			candidateLimit,
		);
		let semanticHits: WorkspaceSearchHit[] = [];
		if (hooks.generateEmbedding) {
			const embedding = await hooks.generateEmbedding(input.query);
			semanticHits = hooks.searchSemantic(
				input.workspace_id,
				input.user_id,
				embedding,
				resourceTypes,
				candidateLimit,
				threshold,
			);
		}
		const fused = hooks.fuse ? hooks.fuse(lexicalHits, semanticHits, candidateLimit) : lexicalHits;
		hits = hooks.expandNeighbors(
			input.workspace_id,
			fused,
			options.hops ?? 1,
			limit,
		);
	}
	return {
		query: input.query,
		strategy,
		total: hits.length,
		hits,
	};
}
