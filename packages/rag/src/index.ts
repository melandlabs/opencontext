/**
 * @melandlabs/rag - RAG pipeline utilities: chunking, embeddings, and vector stores.
 */

export {
	chunkText,
	countTokens,
	getOptimalChunkSize,
	estimateChunkCount,
} from "./chunking";
export type { ChunkOptions, TextChunk } from "./chunking";

export {
	generateEmbedding,
	generateEmbeddings,
	cosineSimilarity,
	getEmbeddingDimensions,
	getEmbeddingModel,
	getModelPricing,
} from "./embeddings";
export type { EmbeddingResult } from "./embeddings";

export {
	getVectorStore,
	addDocumentToVectorStore,
	searchVectorStore,
	searchHybridVectorStore,
	deleteDocumentFromVectorStore,
	getVectorStoreStats,
	configureVectorService,
	isHybridVectorStore,
	type IVectorStore,
	type IHybridVectorStore,
	type SearchResult,
	type VectorSearchResult,
	type DocumentChunk,
	type HybridSearchFilter,
	type HybridSearchQuery,
	type HybridFusionStrategy,
	type VectorStoreBackend,
	type HybridRetrievalConfig,
	type CustomVectorServiceConfig,
	type LanceDBVectorServiceConfig,
	type MilvusVectorServiceConfig,
	type VectorServiceConfig,
} from "./vector-service";

export {
	HybridSearchAdapter,
	fuseHybridResults,
	type HybridFusionInput,
	type HybridSearchAdapterOptions,
	type LexicalSearchProvider,
} from "./hybrid-search";

export {
	LanceDBStore,
	type LanceDBFtsOptions,
	type LanceDBStoreOptions,
} from "./lancedb-store";

export { MilvusStore, type MilvusStoreOptions } from "./milvus-store";

export { UniversalEmbeddings } from "./universal-embeddings";

export {
	TextLoader,
	AppleDocumentLoader,
	parseFile,
	parseFileToDocument,
	getPdfPageCount,
	shouldUseNativePdf,
	estimateChunkCount as ragEstimateChunkCount,
	isSupportedContentType,
	configureParsers,
	type FileContent,
	type ParsersConfig,
} from "./parsers";

export {
	SQLiteVecStore,
	getSQLiteVecStore,
	resetSQLiteVecStore,
} from "./sqlite-vec-store";

export {
	ChromaVectorStore,
	type ChromaVectorStoreOptions,
} from "./chroma-vector-store";

export {
	getPGVectorStore,
	processDocumentWithPGVector,
	searchWithPGVector,
	deleteDocumentsFromPGVector,
	getDocumentCount,
	listUserDocuments,
	configurePGVector,
} from "./pgvector-store";
