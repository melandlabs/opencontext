/**
 * `@melandlabs/workspace/search/semantic` — vector KNN search.
 *
 * Wraps `WorkspaceStore.searchSemantic` so the API layer can stay
 * store-agnostic. The store handles the widen-and-retry loop and the
 * "no embeddings yet → empty result" fallback.
 *
 * The SQLite backend searches a `sqlite-vec` child table; the Postgres
 * backend searches a `pgvector` child table. Both are optional — a
 * backend without the extension returns no hits and the caller falls
 * back to lexical.
 */

import { type AnyWorkspaceStore, toWorkspaceStore } from "../sqlite-adapter";
import type { WorkspaceSearchHit } from "../types";

export interface SemanticSearchInput {
	workspace_id: string;
	user_id: string;
	queryEmbedding: number[];
	resource_types?: string[];
	limit: number;
	threshold: number;
}

export async function searchSemantic(
	store: AnyWorkspaceStore,
	input: SemanticSearchInput,
): Promise<WorkspaceSearchHit[]> {
	return toWorkspaceStore(store).searchSemantic(input);
}
