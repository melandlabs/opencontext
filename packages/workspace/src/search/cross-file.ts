/**
 * `@melandlabs/workspace/search/cross-file` — hybrid + BFS over cites edges.
 *
 *   1. Run hybrid search to collect the top-`limit * 4` candidates.
 *   2. BFS 1–2 hops over `workspace_reference_edges` to surface neighbour
 *      resources (typically the law clause a contract cites, or the
 *      reference a review result depends on).
 *   3. Re-rank with `edge_boost = 0.1 × (out_degree + in_degree)` so
 *      heavily linked resources surface higher.
 */

import type { SqliteWorkspaceStore } from "../sqlite";
import type { WorkspaceSearchHit } from "../types";
import { fuseHybridHits } from "./hybrid";

export interface CrossFileSearchInput {
	workspace_id: string;
	user_id: string;
	query: string;
	resource_types?: string[];
	limit: number;
	threshold?: number;
	hops?: 1 | 2;
	lexicalSearch: (input: {
		workspace_id: string;
		user_id: string;
		query: string;
		resource_types?: string[];
		limit: number;
	}) => WorkspaceSearchHit[];
	semanticSearch: (input: {
		workspace_id: string;
		user_id: string;
		queryEmbedding: number[];
		resource_types?: string[];
		limit: number;
		threshold: number;
	}) => WorkspaceSearchHit[];
	generateEmbedding?: (text: string) => Promise<number[]>;
}

export async function searchCrossFile(
	store: SqliteWorkspaceStore,
	input: CrossFileSearchInput,
): Promise<WorkspaceSearchHit[]> {
	const candidateLimit = input.limit * 4;
	const lexicalHits = input.lexicalSearch({
		workspace_id: input.workspace_id,
		user_id: input.user_id,
		query: input.query,
		resource_types: input.resource_types,
		limit: candidateLimit,
	});
	let semanticHits: WorkspaceSearchHit[] = [];
	if (input.generateEmbedding) {
		const embedding = await input.generateEmbedding(input.query);
		semanticHits = input.semanticSearch({
			workspace_id: input.workspace_id,
			user_id: input.user_id,
			queryEmbedding: embedding,
			resource_types: input.resource_types,
			limit: candidateLimit,
			threshold: input.threshold ?? 0.7,
		});
	}
	const fused = fuseHybridHits({ lexical: lexicalHits, semantic: semanticHits, limit: candidateLimit });
	return store.expandNeighbors({
		workspace_id: input.workspace_id,
		hits: fused,
		hops: input.hops ?? 1,
		limit: input.limit,
	});
}
