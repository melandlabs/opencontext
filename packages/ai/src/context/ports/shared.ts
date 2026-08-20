/**
 * Shared types for the unified context layer.
 *
 * These types are the canonical vocabulary used by every backend port
 * (`MemoryBackendPort`, `InsightsBackendPort`, `KnowledgeBackendPort`) and by
 * the `ContextStore` facade. Adapters that wrap existing concrete
 * implementations (Postgres `MemoryStorageAdapter`, Chroma, sqlite-vec,
 * pgvector, LangChain RAG, Hyper MCP, etc.) translate their domain-specific
 * shapes into these types so callers can stay storage-agnostic.
 */

/**
 * Logical source of a context hit.
 *
 * - `memory`   : Context Atlas records / summaries / raw messages.
 * - `insights` : User-curated insights surfaced from the host's insights store.
 * - `knowledge`: RAG chunks over indexed documents.
 */
export type ContextSource = "memory" | "insights" | "knowledge";

export const ALL_CONTEXT_SOURCES: readonly ContextSource[] = ["memory", "insights", "knowledge"] as const;

export interface ContextHit {
	/** Stable id within the originating source. */
	id: string;
	source: ContextSource;
	/** Human-readable text used for prompt injection or result rendering. */
	text: string;
	/**
	 * Relevance score in the range returned by the backend. The facade does not
	 * normalize across sources — callers that need a comparable score should
	 * apply their own calibration per source.
	 */
	score: number;
	/** Optional timestamp (ms) used for ordering and recency filters. */
	timestamp?: number;
	/** Backend-specific metadata. Must be JSON-serializable. */
	metadata?: Record<string, unknown>;
}

export interface ContextQueryTimeRange {
	start?: number;
	end?: number;
}

/**
 * Cross-backend query shape. Backends should ignore the fields they do not
 * understand; the facade fans out and merges.
 */
export interface ContextQuery {
	userId: string;
	/**
	 * Free-form query string. When `embedding` is also provided, the embedding
	 * wins. When neither is provided, backends that require a vector return
	 * `[]` rather than throwing.
	 */
	query?: string;
	/** Pre-computed embedding, typically from the user's embedding provider. */
	embedding?: number[];
	/** When omitted, every registered source is queried. */
	sources?: ContextSource[];
	/** Hard cap on per-source results. Default 10. */
	limit?: number;
	/** Cosine-similarity threshold; backends that do not use one ignore it. */
	threshold?: number;
	timeRange?: ContextQueryTimeRange;
	includeArchived?: boolean;
	/** Filter to specific bot ids (insights + raw-message memory). */
	botIds?: string[];
	/** Filter to specific document ids (knowledge / RAG only). */
	documentIds?: string[];
	/**
	 * Forwarded to per-user embedding providers that authenticate per request
	 * (e.g. bring-your-own OpenAI key).
	 */
	authToken?: string;
}

export interface ContextWarning {
	source: ContextSource;
	code: string;
	message: string;
}

export interface ContextSnapshot {
	hits: ContextHit[];
	bySource: Record<ContextSource, ContextHit[]>;
	warnings: ContextWarning[];
}

/**
 * Default limit applied when `ContextQuery.limit` is missing or invalid.
 * Matches the cap used by host-side unified search pipelines.
 */
export const DEFAULT_CONTEXT_QUERY_LIMIT = 10;
export const DEFAULT_CONTEXT_QUERY_THRESHOLD = 0.7;
