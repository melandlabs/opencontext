/**
 * Memory store configuration — injected by the host application.
 *
 * The memory-store package is intentionally decoupled from the
 * opencontext web app's database and env layers. Each consumer wires up
 * its own implementation of these contracts.
 *
 * Required for raw-message persistence:
 *   - `db.getDb()` — returns a Drizzle DB handle
 *   - `env.isTauriMode()` — for sqlite vs postgres selection
 *
 * Required for vector indexing:
 *   - one of `vector.sqlite-vec.dbPath` or `vector.chroma.url`
 *
 * Required for unified semantic search:
 *   - `unified.embedQuery` — the embedding provider's query embedder
 *
 * Optional for cross-source unified search:
 *   - `unified.searchKnowledge` — RAG over uploaded documents
 *   - `unified.searchInsights`   — over extracted insights
 *
 * If `unified.*` are absent, the SDK still works but the corresponding
 * sources in `searchUnifiedMemory` will return empty results with a
 * warning — fine for a standalone memory daemon.
 */

import type { RawMessage } from "./contracts";

export interface MemoryStoreDb {
	/** Resolve the active Drizzle DB handle. Must be server-side. */
	getDb(): unknown;
	/** Whether the DB has finished initializing (optional, for startup gating). */
	isDbInitialized?(): boolean;
	/** Initialize the DB (optional, called by `createMemoryStore` if present). */
	initDb?(): unknown;
	/**
	 * Drizzle table references for the postgres backend. Required when
	 * running outside Tauri mode without a registered factory. The host
	 * application owns the actual schema.
	 */
	tables?: {
		rawMessages?: unknown;
		memorySummaries?: unknown;
	};
}

export interface MemoryStoreEnv {
	/** True when running under Tauri (sqlite local). */
	isTauriMode(): boolean;
	/** Where to place the SQLite DB file (Tauri mode only). */
	getTauriDbPath?(): string;
	/**
	 * Tauri data dir for mkdirSync. Defaults to dirname(getTauriDbPath()).
	 * Provided so callers that use a custom layout don't need to expose
	 * their internal helpers.
	 */
	getTauriDataDir?(): string;
}

export type VectorBackend = "sqlite-vec" | "chroma";

export interface MemoryStoreVectorConfig {
	/** Active backend selector. Defaults to env-based detection. */
	backend?: VectorBackend;
	/** SQLite-vec options (used when backend === "sqlite-vec"). */
	sqliteVec?: {
		dbPath?: string;
		insightsCollection?: string;
	};
	/** Chroma options (used when backend === "chroma"). */
	chroma?: {
		url?: string;
		rawMessagesCollection?: string;
		insightsCollection?: string;
	};
}

export type EmbedQueryFn = (input: {
	userId: string;
	query: string;
	authToken?: string;
}) => Promise<number[]>;

export interface UnifiedSearchKnowledgeResult {
	chunkId: string;
	documentId: string;
	documentName: string;
	content: string;
	similarity: number;
	chunkIndex: number;
}

export interface UnifiedSearchInsightsResult {
	id: string;
	content: string;
	similarity: number;
	metadata: Record<string, unknown>;
}

export interface UnifiedSearchDeps {
	/** Embed a query string using the active user's provider. */
	embedQuery?: EmbedQueryFn;
	/**
	 * Postgres-side ANN search over `raw_messages`. Used when chroma is
	 * not enabled but the host has a postgres-backed manager. If both
	 * chroma and this are absent, the memory source will return empty
	 * (with a warning) in standalone mode.
	 */
	searchRawMessagesAnn?: (input: {
		userId: string;
		queryEmbedding: number[];
		limit: number;
		threshold: number;
		botId?: string;
	}) => Promise<
		Array<{
			id: string;
			content: string;
			similarity: number;
			metadata: Record<string, unknown>;
		}>
	>;
	/** RAG over uploaded knowledge documents. Returns a list of chunk hits. */
	searchKnowledge?: (input: {
		userId: string;
		query: string;
		options: { limit: number; threshold: number; documentIds?: string[] };
		authToken?: string;
	}) => Promise<UnifiedSearchKnowledgeResult[]>;
	/** Semantic search over extracted insights. */
	searchInsights?: (input: {
		userId: string;
		query: string;
		limit: number;
		threshold: number;
		botIds?: string[];
		includeArchived?: boolean;
		authToken?: string;
	}) => Promise<UnifiedSearchInsightsResult[]>;
}

export interface MemoryStoreConfig {
	/** Database handle factory. Required for any persistence. */
	db?: MemoryStoreDb;
	/** Environment helpers. Defaults to a process.env-only stub if omitted. */
	env?: MemoryStoreEnv;
	/** Vector backend config. Defaults to env-based detection. */
	vector?: MemoryStoreVectorConfig;
	/** Optional cross-source search providers. */
	unified?: UnifiedSearchDeps;
	/** Optional logger. Defaults to console. */
	logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Minimal RawMessage shape. Re-exported from indexeddb so callers can
 * construct messages without depending on the package's full schema.
 */
export type { RawMessage };
