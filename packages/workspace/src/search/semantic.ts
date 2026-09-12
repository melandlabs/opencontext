/**
 * `@melandlabs/workspace/search/semantic` — sqlite-vec KNN search.
 *
 * Wraps `SqliteWorkspaceStore.searchSemantic` so the API layer can stay
 * store-agnostic. The store handles the widen-and-retry loop and the
 * "no embeddings yet → empty result" fallback.
 */

import type { SqliteWorkspaceStore } from "../sqlite";
import type { WorkspaceSearchHit } from "../types";

export interface SemanticSearchInput {
	workspace_id: string;
	user_id: string;
	queryEmbedding: number[];
	resource_types?: string[];
	limit: number;
	threshold: number;
}

export function searchSemantic(
	store: SqliteWorkspaceStore,
	input: SemanticSearchInput,
): WorkspaceSearchHit[] {
	return store.searchSemantic(input);
}
