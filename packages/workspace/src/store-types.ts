/**
 * `@melandlabs/workspace` — the storage-agnostic store contract.
 *
 * The package ships two backends behind one API surface:
 *
 *   - SQLite  (`src/sqlite.ts`) — local / desktop. `better-sqlite3` is a
 *     *synchronous* driver, so that store's methods return values directly.
 *   - Postgres (`src/postgres/`) — serverless / cloud. Every statement is
 *     a network round trip, so its methods must be asynchronous.
 *
 * The API layer (`src/api.ts`, `src/okf-backend.ts`, `src/search/*`) talks
 * to this contract, never to a concrete store. It is asynchronous
 * throughout: a synchronous signature cannot express "this may hit the
 * network", and pretending otherwise is how a local-first package ends up
 * with a Postgres backend that silently blocks the event loop.
 *
 * `src/sqlite-adapter.ts` bridges the gap: it wraps the synchronous
 * SQLite store so it satisfies this interface without changing the
 * store's own (widely used) synchronous API.
 *
 * This module must stay free of runtime imports — the Postgres entry
 * point (`@melandlabs/workspace/postgres`) depends on it, and that entry
 * point must not pull in `better-sqlite3` (a native module that is not
 * available in a serverless sandbox).
 */

import type { Citation } from "@melandlabs/contracts";
import type {
	EdgeProvenance,
	ListWorkspaceResourcesInput,
	ListWorkspaceResourcesResult,
	OkfFolderResource,
	WorkspaceEdgeType,
	WorkspaceJob,
	WorkspaceResource,
	WorkspaceResourceVersion,
	WorkspaceSearchHit,
} from "./types";

/**
 * Brand used to tell an async store apart from the synchronous SQLite
 * one without importing the SQLite class (which would drag
 * `better-sqlite3` into the Postgres entry point).
 */
export const WORKSPACE_STORE_BRAND = "workspace-store";

export interface LexicalSearchInput {
	workspace_id: string;
	user_id: string;
	query: string;
	resource_types?: string[];
	limit: number;
}

export interface SemanticSearchInput {
	workspace_id: string;
	user_id: string;
	queryEmbedding: number[];
	resource_types?: string[];
	limit: number;
	threshold: number;
}

export interface ExpandNeighborsInput {
	workspace_id: string;
	user_id: string;
	hits: WorkspaceSearchHit[];
	hops: 1 | 2;
	limit: number;
}

export interface ResolveCitationInput {
	workspace_id: string;
	user_id: string;
	citation: Citation;
}

export type ResolveCitationResult =
	| {
			status: "resolved";
			content: string;
			content_hash: string;
			drift: false;
			resource_id: number;
			version_id: number;
			chunk_index: number;
	  }
	| {
			status: "drifted";
			content: string;
			content_hash: string;
			drift: true;
			expected_hash: string;
			resource_id: number;
			version_id: number;
			chunk_index: number;
	  }
	| { status: "missing"; reason: "chunk_not_found" | "wrong_workspace" };

export interface IndexResourceInput {
	workspace_id: string;
	user_id: string;
	resource: OkfFolderResource;
	/** Compare within the index transaction; an identical committed revision may be retried. */
	expected_version_id?: number | null;
}

export interface IndexResourceResult {
	resource_id: number;
	version_id: number;
	change_kind: WorkspaceResourceVersion["change_kind"];
}

export interface UpsertReferenceEdgesInput {
	workspace_id: string;
	edges: Array<{
		source_resource_id: number;
		source_version_id: number | null;
		target_resource_id: number;
		target_version_id: number | null;
		edge_type: WorkspaceEdgeType;
		quote?: string | null;
		provenance?: EdgeProvenance | null;
	}>;
}

/**
 * Freshness snapshot for the OKF reconcile fast path.
 *
 * `canonical_key` → `{ resource_id, size_bytes, source_mtime }` for every
 * resource that is not soft-deleted AND whose metadata carries a numeric
 * `source_mtime` marker. Rows without the marker (indexed before the fast
 * path existed) don't appear, so their files take the full extraction path
 * once and get stamped on the way through.
 */
export interface OkfSourceFreshness {
	resource_id: number;
	size_bytes: number;
	source_mtime: number | null;
}

/**
 * A resource's current body — the concatenation of its current version's
 * chunks — plus the metadata the distillation pass needs.
 */
export interface WorkspaceResourceBody {
	id: number;
	canonical_key: string;
	title: string;
	current_version_id: number | null;
	resource_type: string;
	body: string;
}

/** The chunk shape the embedding queue consumes. */
export interface WorkspaceChunkRow {
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
	embedding_model: string | null;
	embedding_dimensions: number | null;
	embedding_updated_at: number | null;
}

/**
 * The store contract every backend implements.
 *
 * The method names mirror `ISqliteWorkspaceStore` one-for-one so the two
 * backends stay comparable at a glance; only the return types differ
 * (promises instead of values).
 */
export interface WorkspaceStore {
	/** Brand — see {@link WORKSPACE_STORE_BRAND}. */
	readonly __workspaceStoreBrand: typeof WORKSPACE_STORE_BRAND;
	/** Which backend implements this store. Diagnostics only. */
	readonly backend: "sqlite" | "postgres";

	// ── reads ────────────────────────────────────────────────────────────
	listResources(input: ListWorkspaceResourcesInput): Promise<ListWorkspaceResourcesResult>;
	findResourceByCanonicalKey(input: {
		workspace_id: string;
		canonical_key: string;
	}): Promise<WorkspaceResource | null>;
	getOkfSourceFreshness(input: { workspace_id: string }): Promise<Map<string, OkfSourceFreshness>>;
	searchLexical(input: {
		workspace_id: string;
		user_id: string;
		query: string;
		resource_types?: string[];
		/** Host-authorized resource identities; an empty allowlist returns no hits. */
		canonical_keys?: string[];
		limit: number;
	}): Promise<WorkspaceSearchHit[]>;
	searchSemantic(input: SemanticSearchInput): Promise<WorkspaceSearchHit[]>;
	expandNeighbors(input: ExpandNeighborsInput): Promise<WorkspaceSearchHit[]>;
	resolveCitation(input: ResolveCitationInput): Promise<ResolveCitationResult>;
	/**
	 * Read a resource's current body (its current version's chunks joined)
	 * together with the metadata a distillation pass needs. Returns `null`
	 * when the resource does not exist in the workspace.
	 */
	readResourceBody(input: {
		workspace_id: string;
		resource_id: number;
	}): Promise<WorkspaceResourceBody | null>;

	// ── writes ───────────────────────────────────────────────────────────
	indexResource(input: IndexResourceInput): Promise<IndexResourceResult>;
	upsertReferenceEdges(input: UpsertReferenceEdgesInput): Promise<void>;
	softDeleteMissingResources(input: {
		workspace_id: string;
		presentKeys: Set<string>;
	}): Promise<Array<{ canonical_key: string }>>;
	/**
	 * Soft-delete a single resource by canonical key. Idempotent: returns
	 * `deleted: false` when the resource is missing or already marked.
	 */
	softDeleteResource(input: {
		workspace_id: string;
		canonical_key: string;
	}): Promise<{ deleted: boolean; resource_id: number | null }>;
	linkPromotedFacts(input: {
		workspace_id: string;
		resource_id: number;
		version_id: number;
		fact_ids: string[];
	}): Promise<{ inserted: number }>;
	createJob(input: {
		workspace_id: string;
		kind: WorkspaceJob["kind"];
		total: number;
	}): Promise<WorkspaceJob>;
	updateJobTotal(jobId: number, total: number): Promise<void>;

	// ── embedding queue surface ──────────────────────────────────────────
	fetchPendingChunks(versionId: number, limit: number): Promise<WorkspaceChunkRow[]>;
	writeChunkEmbeddings(
		entries: Array<{ chunkId: string; embedding: number[] }>,
		model: string,
		dimensions: number,
	): Promise<void>;
	ensureChildVectorTable(dimensions: number): Promise<void>;
	markVersionEmbeddingReady(resourceId: number, versionId: number): Promise<void>;
	markVersionEmbeddingPartial(resourceId: number, versionId: number, errorMessage: string): Promise<void>;
	markVersionEmbeddingFailed(resourceId: number, versionId: number, errorMessage: string): Promise<void>;
	markIndexPending(resourceId: number, versionId: number): Promise<void>;
	markIndexDlq(resourceId: number, versionId: number, errorMessage: string): Promise<void>;
	markJobFailed(jobId: number | null, errorMessage: string): Promise<void>;
	markJobDlq(jobId: number, errorMessage: string): Promise<void>;
	markJobInFlight(jobId: number): Promise<void>;
	completeJob(jobId: number, done: number): Promise<void>;
	getDlqJobs(workspace_id?: string): Promise<WorkspaceJob[]>;
}
