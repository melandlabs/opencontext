/**
 * `@melandlabs/workspace/search/lexical` — FTS5 lexical search.
 *
 * Mirrors `packages/sqlite/src/raw-message-manager.ts:332-338` for the
 * FTS5 query construction (`"<term>" OR "<term>"`) and `bm25()` ranking.
 * Per the plan, the lexical pass is the fallback when embeddings haven't
 * been written yet, so it must remain functional before the embedding
 * queue drains.
 */

import type { SqliteWorkspaceStore } from "../sqlite";
import type { WorkspaceSearchHit } from "../types";

export interface LexicalSearchInput {
	workspace_id: string;
	user_id: string;
	query: string;
	resource_types?: string[];
	limit: number;
}

export function searchLexical(store: SqliteWorkspaceStore, input: LexicalSearchInput): WorkspaceSearchHit[] {
	return store.searchLexical(input);
}
