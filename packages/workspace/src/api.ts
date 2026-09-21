/**
 * `@melandlabs/workspace` — three core APIs.
 *
 *   - `updateWorkspaceContext` — scan + index an OKF folder, return job summary
 *   - `searchWorkspaceContext` — multi-strategy hybrid search (lexical /
 *                               semantic / hybrid / cross-file)
 *   - `listWorkspaceResources` — enumerate indexed resources for a project
 *   - `resolveWorkspaceCitation` — cross-layer citation resolver with
 *                                 drift detection (workspace_chunk +
 *                                 host-injected memory_fact + raw_message)
 *
 * The HTTP and MCP entry points (`src/http.ts`, `src/mcp.ts`) build the
 * `RuntimeContext` from request headers / tool args and pass it through
 * here. This layer is storage-agnostic: tests inject their own
 * `SqliteWorkspaceStore` and a mock embedding function.
 */

import type { Citation } from "@melandlabs/contracts";
import { workspaceEmbedQuery } from "./embedding-provider";
import { indexOkfFolder } from "./okf-backend";
import { searchCrossFile } from "./search/cross-file";
import { fuseHybridHits } from "./search/hybrid";
import { searchLexical } from "./search/lexical";
import { searchSemantic } from "./search/semantic";
import type { SqliteWorkspaceStore } from "./sqlite";
import type {
	ListWorkspaceResourcesInput,
	ListWorkspaceResourcesResult,
	RuntimeContext,
	SearchWorkspaceContextInput,
	SearchWorkspaceContextResult,
	UpdateWorkspaceContextInput,
	UpdateWorkspaceContextResult,
} from "./types";

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
		ignoreDirNames: input.ignoreDirNames,
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
		const finalHits =
			hits.length > 0
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

// ---------------------------------------------------------------------------
// resolveWorkspaceCitation — cross-layer citation resolver
// ---------------------------------------------------------------------------

/**
 * What a host-provided resolver returns for `memory_fact` / `raw_message`
 * citations. The workspace store only owns `workspace_chunk` citations;
 * the two cross-layer kinds must be resolved by the caller (which owns
 * the memory store / message store).
 */
export interface CrossLayerResolvedCitation {
	kind: "memory_fact" | "raw_message";
	content: string;
	content_hash: string;
	drift: boolean;
	raw: unknown;
}

export interface ResolveWorkspaceCitationDeps {
	/**
	 * Resolve a `memory_fact` citation to its live content. The workspace
	 * store doesn't own the memory store, so the host wires this in.
	 */
	resolveMemoryFact?: (input: { memory_fact_id: string }) => Promise<CrossLayerResolvedCitation | null>;
	/**
	 * Resolve a `raw_message` citation to its live content (e.g. via
	 * `@melandlabs/memory-store`'s SQLiteRawMessageManager).
	 */
	resolveRawMessage?: (input: { message_id: string }) => Promise<CrossLayerResolvedCitation | null>;
}

/**
 * Resolve a citation back to its live content. Returns drift info when
 * the live content_hash no longer matches the snapshot embedded in the
 * citation — this lets the LLM warn the user ("the cited line was
 * edited since this answer was generated") without ever silently
 * serving stale evidence.
 *
 * The store handles `workspace_chunk` natively. The other two kinds
 * (`memory_fact`, `raw_message`) need host-injected resolvers because
 * they live outside the workspace store.
 */
export async function resolveWorkspaceCitation(
	ctx_rt: RuntimeContext,
	store: SqliteWorkspaceStore,
	input: { citation: Citation; workspace_id?: string },
	deps: ResolveWorkspaceCitationDeps = {},
): Promise<
	| { status: "resolved"; citation: Citation; content: string; drift: false }
	| { status: "drifted"; citation: Citation; content: string; drift: true; expected_hash: string }
	| {
			status: "missing";
			citation: Citation;
			reason: "wrong_workspace" | "chunk_not_found" | "host_resolver_missing";
	  }
> {
	void ctx_rt;
	const citation = input.citation;
	if (citation.kind === "workspace_chunk") {
		const workspaceId = input.workspace_id ?? citation.workspace_id;
		if (!workspaceId) {
			return { status: "missing", citation, reason: "wrong_workspace" };
		}
		const result = store.resolveCitation({ workspace_id: workspaceId, citation });
		if (result.status === "resolved") {
			return { status: "resolved", citation, content: result.content, drift: false };
		}
		if (result.status === "drifted") {
			return {
				status: "drifted",
				citation,
				content: result.content,
				drift: true,
				expected_hash: result.expected_hash,
			};
		}
		return { status: "missing", citation, reason: result.reason };
	}
	if (citation.kind === "memory_fact") {
		if (!deps.resolveMemoryFact) {
			return { status: "missing", citation, reason: "host_resolver_missing" };
		}
		const id = citation.memory_fact_id ?? "";
		const resolved = await deps.resolveMemoryFact({ memory_fact_id: id });
		if (!resolved) return { status: "missing", citation, reason: "chunk_not_found" };
		if (resolved.drift) {
			return {
				status: "drifted",
				citation,
				content: resolved.content,
				drift: true,
				expected_hash: citation.content_hash,
			};
		}
		return { status: "resolved", citation, content: resolved.content, drift: false };
	}
	// raw_message
	if (!deps.resolveRawMessage) {
		return { status: "missing", citation, reason: "host_resolver_missing" };
	}
	const id = citation.message_id ?? "";
	const resolved = await deps.resolveRawMessage({ message_id: id });
	if (!resolved) return { status: "missing", citation, reason: "chunk_not_found" };
	if (resolved.drift) {
		return {
			status: "drifted",
			citation,
			content: resolved.content,
			drift: true,
			expected_hash: citation.content_hash,
		};
	}
	return { status: "resolved", citation, content: resolved.content, drift: false };
}
