/**
 * `@melandlabs/workspace` — SQLite → {@link WorkspaceStore} adapter.
 *
 * `SqliteWorkspaceStore` predates the store contract and stays
 * synchronous: `better-sqlite3` is a synchronous driver and the desktop
 * app depends on that (a folder scan is one blocking call, not a
 * promise chain). The contract, however, is asynchronous — a Postgres
 * round trip cannot be hidden behind a synchronous signature.
 *
 * This adapter is the bridge. It wraps the SQLite store and returns
 * promises around its synchronous results, so the API layer can be
 * written once against the contract and work with either backend.
 *
 * The import of `SqliteWorkspaceStore` is **type-only**: this module must
 * not pull `better-sqlite3` into the Postgres entry point
 * (`@melandlabs/workspace/postgres`), where the native module is not
 * available at all.
 */

import type { SqliteWorkspaceStore } from "./sqlite";
import {
	type ExpandNeighborsInput,
	type IndexResourceInput,
	type IndexResourceResult,
	type OkfSourceFreshness,
	type ResolveCitationInput,
	type ResolveCitationResult,
	type SemanticSearchInput,
	type UpsertReferenceEdgesInput,
	WORKSPACE_STORE_BRAND,
	type WorkspaceChunkRow,
	type WorkspaceResourceBody,
	type WorkspaceStore,
} from "./store-types";
import type {
	ListWorkspaceResourcesInput,
	ListWorkspaceResourcesResult,
	WorkspaceJob,
	WorkspaceResource,
	WorkspaceSearchHit,
} from "./types";

/**
 * Adapts the synchronous SQLite store to the asynchronous contract.
 *
 * Every method is a thin wrapper — the semantics live in the SQLite
 * store, this class only changes the shape of the result.
 */
export class SqliteWorkspaceStoreAdapter implements WorkspaceStore {
	readonly __workspaceStoreBrand = WORKSPACE_STORE_BRAND;
	readonly backend = "sqlite" as const;

	constructor(private readonly store: SqliteWorkspaceStore) {}

	// ── reads ────────────────────────────────────────────────────────────

	listResources(input: ListWorkspaceResourcesInput): Promise<ListWorkspaceResourcesResult> {
		return Promise.resolve(this.store.listResources(input));
	}

	findResourceByCanonicalKey(input: {
		workspace_id: string;
		canonical_key: string;
	}): Promise<WorkspaceResource | null> {
		return Promise.resolve(this.store.findResourceByCanonicalKey(input));
	}

	getOkfSourceFreshness(input: {
		workspace_id: string;
	}): Promise<Map<string, OkfSourceFreshness>> {
		return Promise.resolve(this.store.getOkfSourceFreshness(input));
	}

	searchLexical(input: {
		workspace_id: string;
		user_id: string;
		query: string;
		resource_types?: string[];
		canonical_keys?: string[];
		limit: number;
	}): Promise<WorkspaceSearchHit[]> {
		return Promise.resolve(this.store.searchLexical(input));
	}

	searchSemantic(input: SemanticSearchInput): Promise<WorkspaceSearchHit[]> {
		return Promise.resolve(this.store.searchSemantic(input));
	}

	expandNeighbors(input: ExpandNeighborsInput): Promise<WorkspaceSearchHit[]> {
		return Promise.resolve(this.store.expandNeighbors(input));
	}

	resolveCitation(input: ResolveCitationInput): Promise<ResolveCitationResult> {
		return Promise.resolve(this.store.resolveCitation(input));
	}

	readResourceBody(input: {
		workspace_id: string;
		resource_id: number;
	}): Promise<WorkspaceResourceBody | null> {
		const db = this.store.__testDb;
		const row = db
			.prepare(
				`SELECT id, canonical_key, title, current_version_id, resource_type
         FROM workspace_resources WHERE workspace_id = ? AND id = ?`,
			)
			.get(input.workspace_id, input.resource_id) as
			| {
					id: number;
					canonical_key: string;
					title: string;
					current_version_id: number | null;
					resource_type: string;
			  }
			| undefined;
		if (!row) return Promise.resolve(null);
		const chunks = db
			.prepare(
				`SELECT content FROM workspace_chunks WHERE resource_id = ? AND version_id = ?
         ORDER BY chunk_index ASC`,
			)
			.all(input.resource_id, row.current_version_id) as Array<{ content: string }>;
		return Promise.resolve({
			...row,
			body: chunks.map((chunk) => chunk.content).join("\n\n"),
		});
	}

	// ── writes ───────────────────────────────────────────────────────────

	indexResource(input: IndexResourceInput): Promise<IndexResourceResult> {
		return this.store.indexResource(input);
	}

	upsertReferenceEdges(input: UpsertReferenceEdgesInput): Promise<void> {
		this.store.upsertReferenceEdges(input);
		return Promise.resolve();
	}

	softDeleteMissingResources(input: {
		workspace_id: string;
		presentKeys: Set<string>;
	}): Promise<Array<{ canonical_key: string }>> {
		return Promise.resolve(this.store.softDeleteMissingResources(input));
	}

	softDeleteResource(input: {
		workspace_id: string;
		canonical_key: string;
	}): Promise<{ deleted: boolean; resource_id: number | null }> {
		return Promise.resolve(this.store.softDeleteResource(input));
	}

	linkPromotedFacts(input: {
		workspace_id: string;
		resource_id: number;
		version_id: number;
		fact_ids: string[];
	}): Promise<{ inserted: number }> {
		return Promise.resolve(this.store.linkPromotedFacts(input));
	}

	createJob(input: {
		workspace_id: string;
		kind: WorkspaceJob["kind"];
		total: number;
	}): Promise<WorkspaceJob> {
		return Promise.resolve(this.store.createJob(input));
	}

	updateJobTotal(jobId: number, total: number): Promise<void> {
		this.store.updateJobTotal(jobId, total);
		return Promise.resolve();
	}

	// ── embedding queue surface ──────────────────────────────────────────

	fetchPendingChunks(versionId: number, limit: number): Promise<WorkspaceChunkRow[]> {
		return Promise.resolve(this.store.fetchPendingChunks(versionId, limit));
	}

	writeChunkEmbeddings(
		entries: Array<{ chunkId: string; embedding: number[] }>,
		model: string,
		dimensions: number,
	): Promise<void> {
		this.store.writeChunkEmbeddings(entries, model, dimensions);
		return Promise.resolve();
	}

	ensureChildVectorTable(dimensions: number): Promise<void> {
		this.store.ensureChildVectorTable(dimensions);
		return Promise.resolve();
	}

	markVersionEmbeddingReady(resourceId: number, versionId: number): Promise<void> {
		this.store.markVersionEmbeddingReady(resourceId, versionId);
		return Promise.resolve();
	}

	markVersionEmbeddingPartial(resourceId: number, versionId: number, errorMessage: string): Promise<void> {
		this.store.markVersionEmbeddingPartial(resourceId, versionId, errorMessage);
		return Promise.resolve();
	}

	markVersionEmbeddingFailed(resourceId: number, versionId: number, errorMessage: string): Promise<void> {
		this.store.markVersionEmbeddingFailed(resourceId, versionId, errorMessage);
		return Promise.resolve();
	}

	markIndexPending(resourceId: number, versionId: number): Promise<void> {
		this.store.markIndexPending(resourceId, versionId);
		return Promise.resolve();
	}

	markIndexDlq(resourceId: number, versionId: number, errorMessage: string): Promise<void> {
		this.store.markIndexDlq(resourceId, versionId, errorMessage);
		return Promise.resolve();
	}

	markJobFailed(jobId: number | null, errorMessage: string): Promise<void> {
		this.store.markJobFailed(jobId, errorMessage);
		return Promise.resolve();
	}

	markJobDlq(jobId: number, errorMessage: string): Promise<void> {
		this.store.markJobDlq(jobId, errorMessage);
		return Promise.resolve();
	}

	markJobInFlight(jobId: number): Promise<void> {
		this.store.markJobInFlight(jobId);
		return Promise.resolve();
	}

	completeJob(jobId: number, done: number): Promise<void> {
		this.store.completeJob(jobId, done);
		return Promise.resolve();
	}

	getDlqJobs(workspace_id?: string): Promise<WorkspaceJob[]> {
		return Promise.resolve(this.store.getDlqJobs(workspace_id));
	}
}

/**
 * Is this store already speaking the async contract?
 *
 * The brand check avoids an `instanceof` against the SQLite class, which
 * would require a runtime import of `better-sqlite3`.
 */
export function isWorkspaceStore(value: unknown): value is WorkspaceStore {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { __workspaceStoreBrand?: unknown }).__workspaceStoreBrand === WORKSPACE_STORE_BRAND
	);
}

/**
 * Either backend, as accepted by the host layer.
 *
 * The SQLite store keeps its own synchronous API (the desktop app depends
 * on it); the Postgres store is asynchronous. The host layer accepts both
 * and normalises them through {@link toWorkspaceStore}.
 */
export type AnyWorkspaceStore = WorkspaceStore | SqliteWorkspaceStore;

/**
 * Normalise a store into the async contract.
 *
 * Callers that already hold a `WorkspaceStore` (the Postgres backend, or
 * an adapter they built themselves) get it back untouched; a raw
 * `SqliteWorkspaceStore` is wrapped.
 */
export function toWorkspaceStore(store: AnyWorkspaceStore): WorkspaceStore {
	if (isWorkspaceStore(store)) return store;
	return new SqliteWorkspaceStoreAdapter(store);
}
