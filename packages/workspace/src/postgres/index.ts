/**
 * `@melandlabs/workspace/postgres` — the Postgres backend.
 *
 * Public surface:
 *
 *   - `createPostgresWorkspaceStore()` — open a store (and create the
 *     schema) against a Postgres connection string,
 *   - `PostgresWorkspaceStore`         — the store itself,
 *   - the API layer (`searchWorkspaceContext`, `updateWorkspaceContext`,
 *     `listWorkspaceResources`, `resolveWorkspaceCitation`), re-exported
 *     so a host can run entirely from this entry point.
 *
 * This entry point deliberately does **not** pull in `better-sqlite3`:
 * the native module is unavailable in a serverless sandbox, which is
 * exactly where the Postgres backend is used. Import the store and the
 * API from here and the SQLite driver never enters the bundle.
 */

export {
	PostgresWorkspaceStore,
	createPostgresWorkspaceStore,
} from "./store";
export type { PostgresWorkspaceStoreOptions } from "./store";

export {
	WORKSPACE_POSTGRES_DDL,
	WORKSPACE_POSTGRES_SCHEMA_VERSION,
	workspaceVectorTableDdl,
	workspaceVectorTableName,
} from "./schema";

export { buildTsQueryExpression, workspaceTsQueryFragments } from "./tokens";

export {
	listWorkspaceResources,
	resolveWorkspaceCitation,
	searchWorkspaceContext,
	updateWorkspaceContext,
} from "../api";
export type {
	ResolveWorkspaceCitationDeps,
	SearchWorkspaceContextDeps,
} from "../api";
