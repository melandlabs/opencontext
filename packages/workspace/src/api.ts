/**
 * `@melandlabs/workspace` — three core APIs.
 *
 *   - `updateWorkspaceContext` — scan + index an OKF folder, return job summary
 *   - `searchWorkspaceContext` — multi-strategy hybrid search (lexical /
 *                               semantic / hybrid / cross-file)
 *   - `listWorkspaceResources` — enumerate indexed resources for a project
 *
 * The HTTP and MCP entry points (`src/http.ts`, `src/mcp.ts`) build the
 * `RuntimeContext` from request headers / tool args and pass it through
 * here. This layer is storage-agnostic: tests inject their own
 * `SqliteWorkspaceStore` and a mock embedding function.
 */

import type {
	ListWorkspaceResourcesInput,
	ListWorkspaceResourcesResult,
	RuntimeContext,
	SearchWorkspaceContextInput,
	SearchWorkspaceContextResult,
	UpdateWorkspaceContextInput,
	UpdateWorkspaceContextResult,
} from "./types";
import { indexOkfFolder } from "./okf-backend";
import { searchLexical } from "./search/lexical";
import { searchSemantic } from "./search/semantic";
import { searchCrossFile } from "./search/cross-file";
import { fuseHybridHits } from "./search/hybrid";
import type { SqliteWorkspaceStore } from "./sqlite";
import { workspaceEmbedQuery } from "./embedding-provider";

/**
 * Only `okf_folder` is supported as a source today. Any other value
 * triggers an explicit `unsupported_source` error so the HTTP / MCP
 * layers (when re-introduced) can surface a 400 with a clear message.
 */
export async function updateWorkspaceContext(
	ctx_rt: RuntimeContext,
	store: SqliteWorkspaceStore,
	input: UpdateWorkspaceContextInput,
	hooks: {
		enqueueEmbedding?: (input: { resource_id: number; version_id: number; jobId?: number }) => Promise<void>;
	} = {},
): Promise<UpdateWorkspaceContextResult> {
	if (!input.workspace_id) throw new Error("workspace_id is required");
	if (input.source !== "okf_folder") {
		throw new Error(`unsupported source: ${String(input.source)} (only 'okf_folder' is supported)`);
	}
	if (!input.path) throw new Error("path is required");
	const enqueueEmbedding = hooks.enqueueEmbedding ?? (async () => {});
	return indexOkfFolder(store, {
		workspace_id: input.workspace_id,
		user_id: ctx_rt.user_id,
		path: input.path,
		enqueueEmbedding,
	});
}

export interface SearchWorkspaceContextDeps {
	/** Optional embedding override (tests inject deterministic mocks). */
	embed?: (text: string) => Promise<number[]>;
}

/**
 * `searchWorkspaceContext` — the unified search entry. Strategy is one of
 *   - `lexical`   — FTS5 only
 *   - `semantic`  — sqlite-vec only (with lexical fallback when no embeddings yet)
 *   - `hybrid`    — lexical + semantic RRF (default)
 *   - `cross-file`— hybrid + cites-edge BFS
 */
export async function searchWorkspaceContext(
	ctx_rt: RuntimeContext,
	store: SqliteWorkspaceStore,
	input: SearchWorkspaceContextInput,
	deps: SearchWorkspaceContextDeps = {},
): Promise<SearchWorkspaceContextResult> {
	if (!input.workspace_id) throw new Error("workspace_id is required");
	if (!input.query) throw new Error("query is required");
	const embed = deps.embed ?? workspaceEmbedQuery;
	const limit = Math.max(1, Math.min(50, Math.floor(input.options?.limit ?? 10)));
	const strategy = input.strategy ?? "hybrid";
	const resourceTypes = input.options?.resource_types;

	if (strategy === "lexical") {
		const hits = searchLexical(store, {
			workspace_id: input.workspace_id,
			user_id: ctx_rt.user_id,
			query: input.query,
			resource_types: resourceTypes,
			limit,
		});
		return { query: input.query, strategy, total: hits.length, hits };
	}
	if (strategy === "semantic") {
		const embedding = await embed(input.query);
		const hits = searchSemantic(store, {
			workspace_id: input.workspace_id,
			user_id: ctx_rt.user_id,
			queryEmbedding: embedding,
			resource_types: resourceTypes,
			limit,
			threshold: input.options?.threshold ?? 0.7,
		});
		// Fallback to lexical when no embeddings are written yet so the
		// user still gets a hit during the indexing warm-up window.
		const finalHits = hits.length > 0
			? hits
			: searchLexical(store, {
					workspace_id: input.workspace_id,
					user_id: ctx_rt.user_id,
					query: input.query,
					resource_types: resourceTypes,
					limit,
				});
		return { query: input.query, strategy, total: finalHits.length, hits: finalHits };
	}
	if (strategy === "cross-file") {
		const hits = await searchCrossFile(store, {
			workspace_id: input.workspace_id,
			user_id: ctx_rt.user_id,
			query: input.query,
			resource_types: resourceTypes,
			limit,
			threshold: input.options?.threshold ?? 0.7,
			hops: input.options?.hops ?? 1,
			lexicalSearch: (params) => searchLexical(store, params),
			semanticSearch: (params) => searchSemantic(store, params),
			generateEmbedding: embed,
		});
		return { query: input.query, strategy, total: hits.length, hits };
	}
	// hybrid (default)
	const candidateLimit = limit * 4;
	const lexicalHits = searchLexical(store, {
		workspace_id: input.workspace_id,
		user_id: ctx_rt.user_id,
		query: input.query,
		resource_types: resourceTypes,
		limit: candidateLimit,
	});
	let semanticHits: WorkspaceSearchHitRef[] = [];
	try {
		const embedding = await embed(input.query);
		semanticHits = searchSemantic(store, {
			workspace_id: input.workspace_id,
			user_id: ctx_rt.user_id,
			queryEmbedding: embedding,
			resource_types: resourceTypes,
			limit: candidateLimit,
			threshold: input.options?.threshold ?? 0.7,
		});
	} catch (error) {
		// Embedding failure (no API key, network) — degrade to lexical only.
		semanticHits = [];
		void error;
	}
	const hits = fuseHybridHits({ lexical: lexicalHits, semantic: semanticHits, limit });
	return { query: input.query, strategy, total: hits.length, hits };
}

// `WorkspaceSearchHitRef` alias kept inline so the import list stays tight.
type WorkspaceSearchHitRef = SearchWorkspaceContextResult["hits"][number];

export async function listWorkspaceResources(
	ctx_rt: RuntimeContext,
	store: SqliteWorkspaceStore,
	input: ListWorkspaceResourcesInput,
): Promise<ListWorkspaceResourcesResult> {
	if (!input.workspace_id) throw new Error("workspace_id is required");
	void ctx_rt; // Reserved for future per-user ACL filtering on the listing.
	return store.listResources(input);
}
