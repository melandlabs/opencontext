/**
 * `@melandlabs/workspace/search/lexical` — lexical search.
 *
 * Wraps `WorkspaceStore.searchLexical` so the API layer can stay
 * store-agnostic. The SQLite backend matches with FTS5; the Postgres
 * backend matches with a `tsvector` — both rank the same derived token
 * stream, so a query that hits one hits the other.
 *
 * The call is asynchronous because the contract is: a Postgres round trip
 * cannot be hidden behind a synchronous signature.
 */

import { type AnyWorkspaceStore, toWorkspaceStore } from "../sqlite-adapter";
import type { WorkspaceSearchHit } from "../types";

export interface LexicalSearchInput {
	workspace_id: string;
	user_id: string;
	query: string;
	resource_types?: string[];
	limit: number;
}

export async function searchLexical(
	store: AnyWorkspaceStore,
	input: LexicalSearchInput,
): Promise<WorkspaceSearchHit[]> {
	return toWorkspaceStore(store).searchLexical(input);
}
