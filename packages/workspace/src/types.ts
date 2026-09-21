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
export type WorkspaceIndexStatus = "pending" | "partial" | "ready" | "failed" | "dlq";
export type WorkspaceSearchStrategy = "lexical" | "semantic" | "hybrid" | "cross-file";

/**
 * Edge provenance — who/what wrote it, and with what reasoning. Stored
 * as a JSON blob on `workspace_reference_edges.provenance` (schema v2).
 *
 * `source` discriminates the writer so `reconcileResourceEdges` can
 * safely prune edges from automated passes (LLM distillation, OKF
 * link resolver, bulk import) without ever touching manually-authored
 * edges (`source: "manual"`).
 */
export type EdgeProvenance =
	| {
			source: "manual";
			created_by?: string;
			rationale?: string;
	  }
	| {
			source: "okf_link_resolver";
			run_id: string;
			resolved_at: number;
	  }
	| {
			source: "okf_frontmatter";
			run_id: string;
			resolved_at: number;
	  }
	| {
			source: "llm_distill";
			run_id: string;
			extractor_model?: string;
			confidence?: number;
			rationale?: string;
			resolved_at: number;
	  }
	| {
			source: "promote_facts";
			run_id: string;
			fact_ids: string[];
			resolved_at: number;
	  }
	| {
			source: "import";
			importer: string;
			run_id: string;
			resolved_at: number;
	  };

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
	provenance?: EdgeProvenance | null;
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
	reference_edges: Array<{
		edge_type: WorkspaceEdgeType;
		target_resource_id: number;
		provenance?: EdgeProvenance | null;
	}>;
	/**
	 * Memory facts this chunk was promoted from (Tier 4.1). Empty
	 * array when the chunk was authored directly in OKF and never
	 * synthesised from a fact.
	 */
	promoted_fact_ids: string[];
	/**
	 * First-class citation envelope — see `packages/contracts/citation.ts`.
	 * Identical shape across memory / workspace layers so the LLM
	 * can render a uniform reference block.
	 */
	citation: import("@melandlabs/contracts").Citation;
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
	/** Extra directory names the folder walk skips (see `OkfFolderWalkOptions`). */
	ignoreDirNames?: ReadonlySet<string>;
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
