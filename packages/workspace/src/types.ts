/**
 * `@melandlabs/workspace` — core types.
 *
 * All cross-package inputs / outputs flow through this module so the
 * API surface (`updateWorkspaceContext` / `searchWorkspaceContext` /
 * `listWorkspaceResources`) and the HTTP / MCP wiring can share one
 * canonical definition.
 */

import type { OkfFrontMatter } from "@melandlabs/contracts";

export interface RuntimeContext {
	user_id: string;
	employee_id?: string;
	session_id?: string;
	request_id: string;
	mode?: "sandbox" | "client";
	auth_token?: string;
}

export type WorkspaceStorageKind = "okf_local_dir" | "inline";
export type WorkspaceEdgeType = "cites" | "supersedes" | "amends" | "relates-to";
export type WorkspaceIndexStatus = "pending" | "partial" | "ready" | "failed";
export type WorkspaceSearchStrategy = "lexical" | "semantic" | "hybrid" | "cross-file";

export interface WorkspaceResource {
	id: number;
	workspace_id: string;
	user_id: string;
	resource_type: string;
	canonical_key: string;
	title: string;
	storage_kind: WorkspaceStorageKind;
	current_version_id: number | null;
	index_status: WorkspaceIndexStatus;
	created_at: number;
	updated_at: number;
	metadata?: Record<string, unknown>;
}

export interface WorkspaceResourceVersion {
	id: number;
	resource_id: number;
	version_number: number;
	sha256: string;
	change_kind: "created" | "modified" | "unchanged";
	size_bytes: number;
	parent_version_id: number | null;
	source_path: string | null;
	created_at: number;
	metadata?: Record<string, unknown>;
}

export interface WorkspaceChunk {
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
	embedding?: number[];
	embedding_model?: string;
	embedding_dimensions?: number;
	embedding_updated_at?: number;
}

export interface WorkspaceReferenceEdge {
	id: number;
	workspace_id: string;
	source_resource_id: number;
	source_version_id: number | null;
	target_resource_id: number;
	target_version_id: number | null;
	edge_type: WorkspaceEdgeType;
	quote?: string | null;
	created_at: number;
}

export interface WorkspaceJob {
	id: number;
	workspace_id: string;
	kind: "index" | "update";
	status: WorkspaceIndexStatus;
	total: number;
	done: number;
	error: string | null;
	created_at: number;
	updated_at: number;
}

export interface WorkspaceSearchHit {
	chunk_id: string;
	resource_id: number;
	version_id: number;
	resource_type: string;
	resource_title: string;
	canonical_key: string;
	snippet: string;
	matched_terms: string[];
	score: number;
	signals: {
		lexical?: number;
		semantic?: number;
		edge_boost?: number;
	};
	reference_edges: Array<{ edge_type: WorkspaceEdgeType; target_resource_id: number }>;
}

export interface SearchWorkspaceContextOptions {
	/** Default 10, max 50. */
	limit?: number;
	resource_types?: string[];
	/** Default 0.7. */
	threshold?: number;
	/** Only honoured by the `cross-file` strategy. */
	include_edges?: boolean;
	/** Only honoured by the `cross-file` strategy. */
	hops?: 1 | 2;
}

export interface UpdateWorkspaceContextInput {
	workspace_id: string;
	source: "okf_folder";
	path: string;
	metadata?: Record<string, unknown>;
}

export interface UpdateWorkspaceContextResult {
	jobId: number;
	triggered: true;
	status: WorkspaceIndexStatus;
	filesScanned: number;
	filesAdded: number;
	filesModified: number;
	filesUnchanged: number;
	filesDeleted: number;
}

export interface SearchWorkspaceContextInput {
	workspace_id: string;
	query: string;
	strategy?: WorkspaceSearchStrategy;
	options?: SearchWorkspaceContextOptions;
}

export interface SearchWorkspaceContextResult {
	query: string;
	strategy: WorkspaceSearchStrategy;
	total: number;
	hits: WorkspaceSearchHit[];
}

export interface ListWorkspaceResourcesInput {
	workspace_id: string;
	resource_type?: string;
	index_status?: WorkspaceIndexStatus;
	limit?: number;
	offset?: number;
}

export interface ListWorkspaceResourcesResult {
	total: number;
	resources: WorkspaceResource[];
}

/**
 * Internal: the resource shape produced by `okf-backend.listOkfFolderResources`
 * and consumed by `SqliteWorkspaceStore.indexResource`.
 */
export interface OkfFolderResource {
	canonical_key: string;
	absolute_path: string;
	title: string;
	resource_type: string;
	body: string;
	front_matter?: OkfFrontMatter;
	size_bytes: number;
}
