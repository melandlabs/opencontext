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

export {
	updateWorkspaceContext,
	searchWorkspaceContext,
	listWorkspaceResources,
	resolveWorkspaceCitation,
} from "./api";
export type {
	SearchWorkspaceContextDeps,
	ResolveWorkspaceCitationDeps,
	CrossLayerResolvedCitation,
} from "./api";

export { indexOkfFolder, listOkfFolderResources } from "./okf-backend";
export {
	detectMimeType,
	extractText,
	extractTextRaw,
	stripHtmlTags,
} from "./parsers-adapter";
export type { ExtractedText } from "./parsers-adapter";

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

// ── v0.3 wiki-distillation surface ────────────────────────────────────
export { distillResource } from "./distill";
export type { DistillResourceInput, DistillResourceOutput, DistilledEdgeProposal } from "./distill";

export { promoteFactsToPage } from "./promote";
export type { PromoteFactsInput, PromoteFactsOutput, PromotedFact } from "./promote";

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
	EdgeProvenance,
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
