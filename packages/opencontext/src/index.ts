/**
 * @melandlabs/opencontext — single-package facade.
 *
 * Re-exports every public surface of the OpenContext runtime so a host
 * application needs only one dependency:
 *
 *     pnpm add @melandlabs/opencontext
 *     import { createMemoryStore } from "@melandlabs/opencontext";
 *
 * Underlying workspace packages (@melandlabs/contracts,
 * @melandlabs/memory-store, @melandlabs/rag, @melandlabs/loop,
 * @melandlabs/ai) are bundled at build time and do not appear as runtime
 * dependencies in the published manifest.
 */

// ─── 1. Boundary contracts (types, schemas, errors, integration ids) ──────
// `UserType` lives here canonically — the broader channel-aware union
// from `@melandlabs/ai` is renamed to `AIUserType` in ai-reexport.ts to
// avoid a duplicate-type conflict on this facade.
export * from "@melandlabs/contracts";

// ─── 2. Memory store: the four-verb memory API + unified search ───────────
export {
	createMemoryStore,
	createRawMessageStore,
	getRawMessageManager,
	isRawMessageStorageAvailable,
	getRawMessageStorageBackend,
	closeRawMessageStore,
	registerPostgresFactory,
	clearPostgresFactory,
	hasPostgresFactory,
	resolvePostgresFactory,
	clampUnifiedMemorySearchLimit,
	clampUnifiedMemorySearchThreshold,
	isRawMemorySemanticResult,
	mergeUnifiedMemorySearchResults,
	normalizeUnifiedMemorySearchSources,
	toKnowledgeResult,
	toMemoryResult,
} from "@melandlabs/memory-store";

export type {
	MemoryStore,
	MemoryStoreConfig,
	RawMessageStorageBackend,
	RawMessageStorageManagerWithSearch,
	PostgresFactoryFn,
	PostgresRawMessageManagerLike,
	UnifiedMemorySearchInput,
	UnifiedMemorySearchOutput,
	UnifiedMemorySearchResult,
	UnifiedMemorySearchSource,
	UnifiedMemorySearchWarning,
	MemoryStoreDb,
	MemoryStoreEnv,
	VectorBackend,
	EmbedQueryFn,
	UnifiedSearchKnowledgeResult,
	UnifiedSearchInsightsResult,
	RawMessage,
} from "@melandlabs/memory-store";

// Unified search facade (its own subpath entry).
export { createUnifiedSearch } from "@melandlabs/memory-store/unified-search";
export type { UnifiedSearch } from "@melandlabs/memory-store/unified-search";

// ─── 3. Retrieval: chunking, embeddings, vector stores, parsers ──────────
export {
	chunkText,
	countTokens,
	getOptimalChunkSize,
	estimateChunkCount,
	generateEmbedding,
	generateEmbeddings,
	cosineSimilarity,
	getEmbeddingDimensions,
	getEmbeddingModel,
	getModelPricing,
	getVectorStore,
	addDocumentToVectorStore,
	searchVectorStore,
	deleteDocumentFromVectorStore,
	getVectorStoreStats,
	configureVectorService,
	UniversalEmbeddings,
	TextLoader,
	AppleDocumentLoader,
	parseFile,
	parseFileToDocument,
	getPdfPageCount,
	shouldUseNativePdf,
	isSupportedContentType,
	configureParsers,
	SQLiteVecStore,
	getSQLiteVecStore,
	resetSQLiteVecStore,
	ChromaVectorStore,
} from "@melandlabs/rag";

export type {
	ChunkOptions,
	TextChunk,
	EmbeddingResult,
	IVectorStore,
	SearchResult,
	FileContent,
	ParsersConfig,
	VectorSearchResult,
	DocumentChunk,
	ChromaVectorStoreOptions,
} from "@melandlabs/rag";

// ─── 4. Loop engine: filesystem paths, CLI paths, preferences ────────────
export * from "@melandlabs/loop";

// ─── 5. Agent runtime: every ai export except the conflicting UserType ────
// `UserType` from `@melandlabs/ai` is renamed to `AIUserType` here.
export * from "./ai-reexport";

// ─── 6. CLI entry points (used by the bundled bin scripts in dist/cli/) ──
// Re-export the server starters so the CLI bins can import them through
// the facade's main bundle (one canonical copy of the code).
export { startHttpServer } from "@melandlabs/memory-store/http";
export { startMcpServer } from "@melandlabs/memory-store/mcp";
