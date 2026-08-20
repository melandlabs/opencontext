/**
 * Unified vector storage service.
 * Decides which store to use based on either a caller-provided factory or a
 * built-in LanceDB / Milvus backend.
 *
 * Usage (in the app):
 *   import { configureVectorService } from "@melandlabs/rag/vector-service";
 *   configureVectorService({
 *     getStore: async () => { return configuredStore; },
 *   });
 */

export { SQLiteVecStore } from "./sqlite-vec-store";
export { getSQLiteVecStore, resetSQLiteVecStore } from "./sqlite-vec-store";

export {
	getPGVectorStore,
	processDocumentWithPGVector,
	searchWithPGVector,
	deleteDocumentsFromPGVector,
	getDocumentCount,
	listUserDocuments,
} from "./pgvector-store";

export interface EmbeddingResult {
	embedding: number[];
	dimensions: number;
	model: string;
}

export interface SearchResult {
	content: string;
	score: number;
	metadata?: Record<string, unknown>;
}

/**
 * Unified vector storage interface.
 */
export interface IVectorStore {
	addChunk(chunk: DocumentChunk): Promise<void>;
	addChunks(chunks: DocumentChunk[]): Promise<void>;
	similaritySearch(queryEmbedding: number[], limit?: number, userId?: string): Promise<VectorSearchResult[]>;
	/**
	 * Optional capability implemented by stores that support lexical + vector
	 * retrieval. Use {@link isHybridVectorStore} before calling it when the
	 * concrete backend is not known.
	 */
	hybridSearch?(query: HybridSearchQuery): Promise<VectorSearchResult[]>;
	deleteDocument(documentId: string): Promise<void>;
	getDocumentCount(): Promise<number>;
	getChunkCount(): Promise<number>;
	clear(): Promise<void>;
}

export interface IHybridVectorStore extends IVectorStore {
	hybridSearch(query: HybridSearchQuery): Promise<VectorSearchResult[]>;
}

export type HybridFusionStrategy = "rrf" | "weighted";

export interface HybridSearchFilter {
	userId?: string;
	documentIds?: string[];
}

export interface HybridSearchQuery {
	/** The raw query used by the BM25/full-text branch. */
	text: string;
	/** Query embedding used by the dense branch. Omit for lexical-only search. */
	vector?: number[];
	/** Number of fused results to return. */
	limit?: number;
	/** Number of candidates requested from each retrieval branch. */
	candidateLimit?: number;
	/** Fusion algorithm. RRF is the tuning-free default. */
	fusion?: HybridFusionStrategy;
	/** Dense weight for weighted fusion. Must be between 0 and 1. */
	alpha?: number;
	/** RRF rank constant. Defaults to 60. */
	rrfK?: number;
	filter?: HybridSearchFilter;
}

export function isHybridVectorStore(store: IVectorStore): store is IHybridVectorStore {
	return typeof store.hybridSearch === "function";
}

export interface VectorSearchResult {
	id: string;
	content: string;
	score: number;
	documentId: string;
	metadata?: Record<string, unknown>;
}

export interface DocumentChunk {
	id: string;
	documentId: string;
	content: string;
	embedding: number[];
	metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type VectorStoreBackend = "sqlite-vec" | "pgvector" | "lancedb" | "milvus" | "custom";

export interface HybridRetrievalConfig {
	enabled?: boolean;
	fusion?: HybridFusionStrategy;
	alpha?: number;
	rrfK?: number;
	candidateMultiplier?: number;
}

export interface CustomVectorServiceConfig {
	getStore: () => Promise<IVectorStore>;
	backend?: VectorStoreBackend;
	hybrid?: HybridRetrievalConfig;
}

export interface LanceDBVectorServiceConfig {
	backend: "lancedb";
	lancedb: import("./lancedb-store").LanceDBStoreOptions;
	hybrid?: HybridRetrievalConfig;
}

export interface MilvusVectorServiceConfig {
	backend: "milvus";
	milvus: import("./milvus-store").MilvusStoreOptions;
	hybrid?: HybridRetrievalConfig;
}

export type VectorServiceConfig =
	| CustomVectorServiceConfig
	| LanceDBVectorServiceConfig
	| MilvusVectorServiceConfig;

let _config: VectorServiceConfig | null = null;
let _backendStore: Promise<IVectorStore> | null = null;

/**
 * Configure the vector service with the store factory provided by the caller.
 * Must be called before getVectorStore().
 */
export function configureVectorService(config: VectorServiceConfig): void {
	_config = config;
	_backendStore = null;
}

function getConfig(): VectorServiceConfig | null {
	return _config;
}

// ---------------------------------------------------------------------------
// Vector store factory
// ---------------------------------------------------------------------------

/**
 * Get the configured vector store instance.
 */
export async function getVectorStore(): Promise<IVectorStore> {
	const config = getConfig();

	if (!config) {
		throw new Error("Vector service not configured. Call configureVectorService() first.");
	}

	if ("getStore" in config) {
		return await config.getStore();
	}

	_backendStore ??= createBackendStore(config);
	return await _backendStore;
}

async function createBackendStore(
	config: LanceDBVectorServiceConfig | MilvusVectorServiceConfig,
): Promise<IVectorStore> {
	const hybrid = config.hybrid;
	const hybridDefaults = {
		defaultFusion: hybrid?.fusion,
		defaultAlpha: hybrid?.alpha,
		defaultRrfK: hybrid?.rrfK,
		candidateMultiplier: hybrid?.candidateMultiplier,
	};

	if (config.backend === "lancedb") {
		const { LanceDBStore } = await import("./lancedb-store");
		return new LanceDBStore({ ...hybridDefaults, ...config.lancedb });
	}

	const { MilvusStore } = await import("./milvus-store");
	return new MilvusStore({ ...hybridDefaults, ...config.milvus });
}

function getHybridConfig(): HybridRetrievalConfig | undefined {
	return _config?.hybrid;
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

export async function addDocumentToVectorStore(
	documentId: string,
	chunks: Array<{
		content: string;
		embedding: number[];
		metadata?: Record<string, unknown>;
	}>,
): Promise<void> {
	const vectorStore = await getVectorStore();

	const documentChunks: DocumentChunk[] = chunks.map((chunk, index) => ({
		id: `${documentId}_chunk_${index}`,
		documentId,
		content: chunk.content,
		embedding: chunk.embedding,
		metadata: {
			...chunk.metadata,
			chunkIndex: index,
		},
	}));

	await vectorStore.addChunks(documentChunks);
	console.log(`✅ Added ${chunks.length} chunks to vector store`);
}

export async function searchVectorStore(
	queryEmbedding: number[],
	limit = 10,
	userId?: string,
): Promise<SearchResult[]> {
	const vectorStore = await getVectorStore();

	const results = await vectorStore.similaritySearch(queryEmbedding, limit, userId);

	return results.map((r) => ({
		content: r.content,
		score: r.score,
		metadata: r.metadata,
	}));
}

/**
 * Search the configured store with lexical + dense retrieval when supported.
 * Existing sqlite-vec / pgvector stores remain vector-only and use the dense
 * branch as a backwards-compatible fallback.
 */
export async function searchHybridVectorStore(
	query: HybridSearchQuery,
): Promise<VectorSearchResult[]> {
	const vectorStore = await getVectorStore();
	const defaults = getHybridConfig();

	if (defaults?.enabled !== false && isHybridVectorStore(vectorStore)) {
		const limit = query.limit ?? 10;
		return await vectorStore.hybridSearch({
			...query,
			fusion: query.fusion ?? defaults?.fusion,
			alpha: query.alpha ?? defaults?.alpha,
			rrfK: query.rrfK ?? defaults?.rrfK,
			candidateLimit:
				query.candidateLimit ??
				(defaults?.candidateMultiplier ? limit * defaults.candidateMultiplier : undefined),
		});
	}

	if (!query.vector?.length) return [];
	const results = await vectorStore.similaritySearch(
		query.vector,
		query.limit,
		query.filter?.userId,
	);
	if (!query.filter?.documentIds?.length) return results;
	const allowedDocumentIds = new Set(query.filter.documentIds);
	return results.filter((result) => allowedDocumentIds.has(result.documentId));
}

export async function deleteDocumentFromVectorStore(documentId: string): Promise<void> {
	const vectorStore = await getVectorStore();
	await vectorStore.deleteDocument(documentId);
	console.log(`✅ Deleted document ${documentId} from vector store`);
}

export async function getVectorStoreStats(): Promise<{
	documentCount: number;
	chunkCount: number;
}> {
	const vectorStore = await getVectorStore();

	const [documentCount, chunkCount] = await Promise.all([
		vectorStore.getDocumentCount(),
		vectorStore.getChunkCount(),
	]);

	return { documentCount, chunkCount };
}
