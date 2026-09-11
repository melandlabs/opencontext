/**
 * `@melandlabs/workspace` — barrel re-export.
 *
 * Mirrors the OKF subpath shape:
 *   - root:                    low-level API surface (api, types, schema, sqlite)
 *   - `/sqlite`                `getSQLiteWorkspaceStore()` / `closeSQLiteWorkspaceStore()`
 *   - `/cli`                   `opencontext workspace …` subcommand
 */

export {
	getSQLiteWorkspaceStore,
	closeSQLiteWorkspaceStore,
	resolveWorkspaceDbPath,
	createSqliteWorkspaceStore,
	__resetSQLiteWorkspaceStoreForTests,
} from "./sqlite";
export type { SqliteWorkspaceStore, SqliteWorkspaceStoreOptions } from "./sqlite";

export { updateWorkspaceContext, searchWorkspaceContext, listWorkspaceResources } from "./api";
export type { SearchWorkspaceContextDeps } from "./api";

export { indexOkfFolder, listOkfFolderResources } from "./okf-backend";

export { searchLexical } from "./search/lexical";
export { searchSemantic } from "./search/semantic";
export { fuseHybridHits } from "./search/hybrid";
export { searchCrossFile } from "./search/cross-file";

export { createEmbeddingQueue } from "./embedding-queue";
export type { EmbeddingQueue, EmbeddingQueueDeps } from "./embedding-queue";

export {
	getWorkspaceEmbeddingProvider,
	workspaceEmbedQuery,
	workspaceEmbedDocuments,
	workspaceEmbeddingModelName,
	workspaceEmbeddingDimensions,
	__resetWorkspaceEmbeddingProviderForTests,
} from "./embedding-provider";
export type {
	WorkspaceEmbeddingProvider,
	WorkspaceEmbeddingProviderType,
} from "./embedding-provider";

export { initializeWorkspaceSchema, WORKSPACE_SCHEMA_VERSION } from "./schema";

export type {
	RuntimeContext,
	WorkspaceStorageKind,
	WorkspaceEdgeType,
	WorkspaceIndexStatus,
	WorkspaceSearchStrategy,
	WorkspaceResource,
	WorkspaceResourceVersion,
	WorkspaceChunk,
	WorkspaceReferenceEdge,
	WorkspaceJob,
	WorkspaceSearchHit,
	SearchWorkspaceContextOptions,
	UpdateWorkspaceContextInput,
	UpdateWorkspaceContextResult,
	SearchWorkspaceContextInput,
	SearchWorkspaceContextResult,
	ListWorkspaceResourcesInput,
	ListWorkspaceResourcesResult,
	OkfFolderResource,
} from "./types";
