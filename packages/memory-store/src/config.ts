/**
 * Memory store configuration — injected by the host application.
 *
 * The memory-store package is intentionally decoupled from the
 * opencontext web app's database layer. Each consumer wires up its own
 * implementation of the `db` contract.
 *
 * Backend selection is env-var driven, not host-injected:
 *   - Default: local SQLite at `~/.opencontext/memory/store.db`
 *     (override with `MEMORY_STORE_DB_PATH`).
 *   - Set `OPENCONTEXT_MEMORY_STORE_BACKEND=postgres` to opt into the
 *     host's registered Postgres factory (call `registerPostgresFactory`
 *     at startup). SQLite stays as the default in every other case.
 *
 * Required for raw-message persistence:
 *   - `db.getDb()` — returns a Drizzle DB handle (Postgres path only)
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

/**
 * Placeholder for the historical host-injected environment. The fields
 * it used to expose (`isTauriMode`, `getTauriDbPath`, `getTauriDataDir`)
 * were Tauri-specific and have been removed. Backend selection is now
 * driven entirely by the `OPENCONTEXT_MEMORY_STORE_BACKEND` env var.
 *
 * The interface is kept (empty) so existing `env?: MemoryStoreEnv`
 * parameters on the public surface still type-check, but new code
 * should not need to construct a value of this type.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty — kept as a named type so existing `env?: MemoryStoreEnv` params still type-check.
export interface MemoryStoreEnv {}

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
	/**
	 * Optional BM25 (lexical) sub-query for the memory source. Mirrors the
	 * `searchRawMessagesAnn` shape but operates on FTS5 keywords instead of
	 * dense embeddings. When absent, the unified pipeline skips the lexical
	 * path and emits a `memory_lexical_search_not_configured` warning.
	 */
	searchRawMessagesLexical?: (input: {
		userId: string;
		keywords: string[];
		limit: number;
		botId?: string;
	}) => Promise<
		Array<{
			id: string;
			content: string;
			similarity: number;
			metadata: Record<string, unknown>;
		}>
	>;
}

export interface MemoryStoreConfig {
	/**
	 * Database handle factory. Required for the Postgres backend
	 * (`OPENCONTEXT_MEMORY_STORE_BACKEND=postgres`).
	 */
	db?: MemoryStoreDb;
	/**
	 * Custom SQLite database file path for the default SQLite backend.
	 *
	 * If provided, this takes precedence over the `MEMORY_STORE_DB_PATH`
	 * environment variable and the default `~/.opencontext/memory/store.db`.
	 *
	 * For backward compatibility with early tutorials, `db.path` is also
	 * honoured when `db` is supplied as `{ type, path }`.
	 */
	dbPath?: string;
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
