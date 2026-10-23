/**
 * `@melandlabs/workspace/core` — the backend-agnostic surface.
 *
 * Everything here works without a SQLite file: the OKF walk, the text
 * extractors, the embedding provider, the hybrid fusion, the store
 * contract and the orchestration layer that drives any
 * {@link WorkspaceStore}.
 *
 * The split exists because the package's other entry points are not
 * free of native code. `@melandlabs/workspace/sqlite` pulls in
 * `better-sqlite3` and `sqlite-vec`, and the root barrel re-exports it
 * — so importing *any* helper from the root entry loads a native module
 * at import time. A serverless host that serves the index from
 * Postgres (`@melandlabs/workspace/postgres`) never touches a SQLite
 * file, and a bundler cannot tree-shake the native module out of a
 * re-exported binding.
 *
 * Importing from this entry instead keeps the dependency graph free of
 * native code: the only modules that import `better-sqlite3` at
 * runtime are `src/sqlite.ts` and `src/cli.ts`, and neither is
 * reachable from here.
 *
 * What is deliberately *not* in this entry:
 *
 *   - the SQLite store itself (`getSQLiteWorkspaceStore`,
 *     `createSqliteWorkspaceStore`, `closeSQLiteWorkspaceStore`,
 *     `resolveWorkspaceDbPath`) — see `@melandlabs/workspace/sqlite`
 *   - the sync→async bridge (`SqliteWorkspaceStoreAdapter`,
 *     `toWorkspaceStore`) — it exists to adapt *that* store
 *
 * @example
 * ```ts
 * // Safe on a serverless host: no native module in the graph.
 * import { fuseHybridHits, workspaceEmbedQuery } from "@melandlabs/workspace/core";
 * ```
 */

export { buildCitationId } from "@melandlabs/contracts";
export type { Citation } from "@melandlabs/contracts";

// ── store contract ──────────────────────────────────────────────────
// The contract itself is runtime-free, so a host can depend on it
// without dragging a native module along.
export { WORKSPACE_STORE_BRAND } from "./store-types";
export type {
	ExpandNeighborsInput,
	IndexResourceInput,
	IndexResourceResult,
	OkfSourceFreshness,
	ResolveCitationInput,
	ResolveCitationResult,
	SemanticSearchInput,
	UpsertReferenceEdgesInput,
	WorkspaceChunkRow,
	WorkspaceResourceBody,
	WorkspaceStore,
} from "./store-types";

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

export {
	SUPPORTED_EXTENSIONS,
	DEFAULT_IGNORED_DIR_NAMES,
	OKF_MAX_EXTRACT_BYTES,
	resourceTypeForExtension,
	indexOkfFolder,
	listOkfFolderResources,
} from "./okf-backend";
export type { OkfFolderWalkOptions } from "./okf-backend";

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
