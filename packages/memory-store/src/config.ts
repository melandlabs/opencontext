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

import type { FactType } from "@melandlabs/contracts";
import type { DerivedFact } from "@melandlabs/contracts/derived-fact";
import type { EntityEdge } from "@melandlabs/contracts/entity-edge";
import type { Peer } from "@melandlabs/contracts/peer";
import type { MemoryApplicabilityContext } from "@melandlabs/memory-consolidation";
import type { RawMessage } from "./contracts";
import type { IterativeRecallPlanner } from "./search/iterative-recall";
import type { QueryRewriter } from "./search/query-rewriter";

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

export interface UnifiedSearchReasoningDeps {
	/**
	 * LLM single-turn synthesis callback. Wired into
	 * `search({ synthesize: true })` so a host that wants synthesis
	 * responses only has to drop in one callable. When omitted, the
	 * synthesis path returns the gathered evidence with a
	 * `synthesize_llm_not_configured` warning instead of throwing.
	 */
	complete?: (prompt: string) => Promise<string>;
	/** Default merge strategy used by `searchUnifiedMemory` when the caller does not specify one. @default "rrf" */
	defaultMergeStrategy?: import("./search/utilities").UnifiedMemoryMergeStrategy;
	/** Optional query rewriter. When present, "rewrite" strategy is available. */
	queryRewriter?: QueryRewriter;
	/** Optional iterative recall planner. When present, "iterative" strategy is available. */
	iterativePlanner?: IterativeRecallPlanner;
	/** Default reasoning strategy when callers do not specify one. @default "none" */
	defaultStrategy?: import("./search/utilities").UnifiedMemoryReasoningStrategy;
}

export interface MemorySummaryHit {
	summaryId: string;
	summaryText: string;
	summaryTier?: "L1" | "L2" | "L3";
	keywords?: string[];
	startTimestamp?: number;
	endTimestamp?: number;
}

/**
 * Trusted applicability fields forwarded together to retrieval providers.
 * They are absent for legacy unscoped searches and always present together
 * for scoped searches. Providers must enforce the canonical applicability
 * contract at `applicabilityAt`; these values must not be derived from public
 * request payloads.
 */
export interface SearchProviderApplicabilityInput {
	applicabilityContexts?: readonly MemoryApplicabilityContext[];
	/** Epoch milliseconds resolved once at the `search()` boundary. */
	applicabilityAt?: number;
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
	searchRawMessagesAnn?: (
		input: SearchProviderApplicabilityInput & {
			userId: string;
			queryEmbedding: number[];
			limit: number;
			threshold: number;
			botId?: string;
			/** Optional peer scope resolved from `UnifiedMemorySearchInput.peerFilter`. */
			peers?: ReadonlyArray<Peer>;
			/** Optional `FactType` filter resolved from `UnifiedMemorySearchInput.factTypes`. */
			factTypes?: FactType[];
		},
	) => Promise<
		Array<{
			id: string;
			content: string;
			similarity: number;
			metadata: Record<string, unknown>;
		}>
	>;
	/** RAG over uploaded knowledge documents. Returns a list of chunk hits. */
	searchKnowledge?: (
		input: SearchProviderApplicabilityInput & {
			userId: string;
			query: string;
			options: { limit: number; threshold: number; documentIds?: string[] };
			authToken?: string;
			/** Optional peer scope resolved from `UnifiedMemorySearchInput.peerFilter`. */
			peers?: ReadonlyArray<Peer>;
		},
	) => Promise<UnifiedSearchKnowledgeResult[]>;
	/** Semantic search over extracted insights. */
	searchInsights?: (
		input: SearchProviderApplicabilityInput & {
			userId: string;
			query: string;
			limit: number;
			threshold: number;
			botIds?: string[];
			includeArchived?: boolean;
			authToken?: string;
			/** Optional peer scope resolved from `UnifiedMemorySearchInput.peerFilter`. */
			peers?: ReadonlyArray<Peer>;
		},
	) => Promise<UnifiedSearchInsightsResult[]>;
	/**
	 * Optional BM25 (lexical) sub-query for the memory source. Mirrors the
	 * `searchRawMessagesAnn` shape but operates on FTS5 keywords instead of
	 * dense embeddings. When absent, the unified pipeline skips the lexical
	 * path and emits a `memory_lexical_search_not_configured` warning.
	 */
	searchRawMessagesLexical?: (
		input: SearchProviderApplicabilityInput & {
			userId: string;
			keywords: string[];
			limit: number;
			botId?: string;
			/** Optional peer scope resolved from `UnifiedMemorySearchInput.peerFilter`. */
			peers?: ReadonlyArray<Peer>;
			/** Optional `FactType` filter resolved from `UnifiedMemorySearchInput.factTypes`. */
			factTypes?: FactType[];
		},
	) => Promise<
		Array<{
			id: string;
			content: string;
			similarity: number;
			metadata: Record<string, unknown>;
		}>
	>;
	/**
	 * Optional summary-tier search. When wired in, `reflect()` consults the
	 * summary tier alongside raw messages and emits a
	 * `reflect_summaries_unavailable` warning if the call fails.
	 */
	searchSummaries?: (
		input: SearchProviderApplicabilityInput & {
			userId: string;
			query: string;
			keywords: string[];
			limit: number;
			threshold: number;
			dateFrom?: string;
			dateTo?: string;
			authToken?: string;
			/** Optional peer scope resolved from `UnifiedMemorySearchInput.peerFilter`. */
			peers?: ReadonlyArray<Peer>;
		},
	) => Promise<MemorySummaryHit[]>;
	/**
	 * Optional entity sub-query provider. Hosts wire this in to opt
	 * into the `entity` channel of unified search: matches are
	 * projected back as `UnifiedMemorySearchResult`s and fused with
	 * semantic + lexical via RRF. Without it, the entity channel is
	 * skipped silently (with a `memory_entity_search_not_configured`
	 * warning when RRF was requested).
	 *
	 * The provider is intentionally narrow: it returns `(messageId,
	 * label, score)` tuples. The host is responsible for keeping its
	 * own entity store (graph nodes, separate SQLite table, etc.) —
	 * the SDK never persists entity edges itself.
	 */
	entitySearch?: (
		input: SearchProviderApplicabilityInput & {
			userId: string;
			keywords: string[];
			limit: number;
			botId?: string;
			/** Optional peer scope resolved from `UnifiedMemorySearchInput.peerFilter`. */
			peers?: ReadonlyArray<Peer>;
		},
	) => Promise<Array<{ messageId: string; label: string; score: number }>>;
	/**
	 * Optional entity extractor wired into the `distill` primitive. The
	 * extractor receives the raw message text and returns a batch of
	 * `EntityEdge`s the host may persist via the `persist` callback
	 * supplied on the `distill` input.
	 *
	 * When omitted, `distill` short-circuits with a
	 * `distill_extractor_not_configured` warning — matching the
	 * `memory_iterative_planner_not_configured` precedent.
	 */
	entityExtractor?: (input: {
		userId: string;
		messageId: string;
		content: string;
	}) => Promise<EntityEdge[]>;
	/**
	 * Optional deriver wired into the `derive` primitive. The deriver
	 * receives a window of candidate fact texts and returns a batch of
	 * `DerivedFact`s the host may persist via the `persist` callback
	 * supplied on the `derive` input.
	 *
	 * When omitted, `derive` short-circuits with a
	 * `derive_deriver_not_configured` warning — same precedent.
	 */
	deriver?: (input: {
		userId: string;
		userScope: { userId: string; botIds?: string[]; dateFrom?: string; dateTo?: string };
		recentFactTexts: string[];
		window?: { from: number; to: number };
	}) => Promise<DerivedFact[]>;
	/**
	 * Optional host-side check that validates whether a `peerFilter` peer is
	 * actually reachable from this `userId`. Used by
	 * `resolveScopePeer` to drop out-of-scope peers with a warning
	 * rather than broadening the search. May be omitted for hosts that
	 * have no peer-permission model.
	 */
	peerScopeCheck?: (input: {
		userId: string;
		peers: ReadonlyArray<import("@melandlabs/contracts/peer").Peer>;
	}) => Promise<boolean> | boolean;
	/** Optional reasoning providers. */
	reasoning?: UnifiedSearchReasoningDeps;
	/**
	 * Optional reranker applied after per-source merge and before the
	 * final limit. Defaults to an identity pass-through so the merge order
	 * is preserved.
	 */
	reranker?: import("./search/reranker").Reranker;
	/**
	 * Optional logger. When set (e.g. via `MemoryStoreConfig.logger`),
	 * `reflect` / `consolidate` log through it instead of `console`.
	 * Falls back to `console` when omitted.
	 */
	logger?: Pick<Console, "log" | "warn" | "error">;
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
	/**
	 * Optional write-back graph store. When set, `createMemoryStore` wires
	 * it into `store.graphStore` and forwards it to `consolidate`. Hosts
	 * that prefer post-construction wiring can use `attachMemoryGraphStore`.
	 */
	graphStore?: import("@melandlabs/memory-consolidation").MemoryGraphStoreWithOperationHistory;
	/**
	 * Optional storage adapter carrying `deprecateRecords`. Forwarded into
	 * `consolidate` for callers that want deprecation writes without
	 * attaching a full graph store.
	 */
	storage?: import("@melandlabs/memory-consolidation").MemoryStorageAdapterLike;
	/** Optional logger. Defaults to console. */
	logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Minimal RawMessage shape. Re-exported from indexeddb so callers can
 * construct messages without depending on the package's full schema.
 */
export type { RawMessage };
