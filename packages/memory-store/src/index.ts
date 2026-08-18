/**
 * @melandlabs/memory-store — SDK entry point.
 *
 * Wires up a top-level `MemoryStore` facade combining the raw message
 * manager, the unified search facade, and vector index helpers. Hosts
 * that want a non-web backend (CLI daemon, custom server) can use
 * this as the only entry point.
 */

import type { MemoryStoreConfig } from "./config";
import type { ApplyReflectInput, ApplyReflectOutput } from "./search/apply-reflect";
import { type UnifiedSearch, createUnifiedSearch } from "./search/unified-search";
import {
	type RawMessageStore,
	configureRawMessageStore,
	createRawMessageStore,
	getRawMessageManager,
} from "./storage/raw-message-store";
import { resolveSQLiteRawMessageDbPath } from "./storage/sqlite-raw-message-store";
import type {
	StoreVsaFactInput,
	StoreVsaFactOutput,
	VsaFactSummary,
	VsaForgetInput,
	VsaForgetOutput,
	VsaListInput,
	VsaRecallInput,
	VsaRecallOutput,
} from "@melandlabs/contracts";
import { getSQLiteVsaStore, type SQLiteVsaStore } from "@melandlabs/sqlite";
import { createVsaRecall, type VsaRecallFacade } from "./search/vsa";

export interface MemoryStore {
	/** Underlying raw-message store (sqlite vs postgres). */
	raw: RawMessageStore;
	/**
	 * Unified semantic search facade (memory + insights + knowledge).
	 * The primary entry point is `store.search.search(input)`. Set
	 * `synthesize: true` to opt into LLM synthesis (the `reflect`
	 * behaviour).
	 */
	search: UnifiedSearch;
	/** Resolve the active raw-message manager. */
	getRawMessageManager: typeof getRawMessageManager;
	/**
	 * @deprecated Use `store.search.search(input)` instead. Forwarding
	 * shim kept for one release window before removal.
	 */
	searchUnifiedMemory: UnifiedSearch["searchUnifiedMemory"];
	/**
	 * @deprecated Use `store.search.search({ ...input, sources: ["memory"] })`
	 * and read `.results` instead.
	 */
	searchRawMemorySemantically: UnifiedSearch["searchRawMemorySemantically"];
	/**
	 * @deprecated Use `store.search.search({ ...input, synthesize: true })`
	 * instead.
	 */
	reflect: UnifiedSearch["reflect"];
	/**
	 * Agentic write-back: gathers evidence, vets a consolidation plan with
	 * the LLM, persists via the attached graph store + soft-deprecates via
	 * the storage adapter. The `graphStore` and `storage` fields are
	 * forwarded from this `MemoryStore` instance when the caller omits them
	 * on the input.
	 */
	reflectWithPlan: (input: ApplyReflectInput) => Promise<ApplyReflectOutput>;
	/**
	 * Optional write-back graph store. Set via `attachMemoryGraphStore`;
	 * consumers can read it for diagnostic / replay tooling. Absent when
	 * the host has not wired one in.
	 */
	graphStore?: import("@melandlabs/memory-consolidation").MemoryGraphStoreWithOperationHistory;
	/**
	 * Optional storage adapter carrying `deprecateRecords`. Forwarded into
	 * `reflectWithPlan` when callers want deprecation writes without
	 * attaching a full graph store.
	 */
	storage?: import("@melandlabs/memory-consolidation").MemoryStorageAdapterLike;
	/**
	 * Vector Symbolic Architecture facade. Always available — backed by
	 * the same SQLite DB the raw-message manager uses. Routes through its
	 * own `vsa_facts` table; never mixed into the unified search.
	 *
	 *   - `vsaStoreFact(input)` — persist a (role, filler) binding.
	 *   - `vsaRecall(input)`    — rebuild memory vector + best-match cleanup.
	 *   - `vsaListFacts(input)` — read-side projection (no vectors).
	 *   - `vsaForget(input)`    — soft-delete by id.
	 */
	vsa: VsaRecallFacade;
}

export async function createMemoryStore(config: MemoryStoreConfig = {}): Promise<MemoryStore> {
	const dbPath =
		config.dbPath ?? (config.db && "path" in config.db ? (config.db as { path?: string }).path : undefined);
	const raw = createRawMessageStore({ env: config.env, dbPath });
	// Forward the host-configured `logger` into the unified-search facade so
	// `reflect` / `reflectWithPlan` honour it instead of always using `console`.
	const search = createUnifiedSearch({ ...config.unified, logger: config.logger });

	// Make the legacy `getRawMessageManager()` module-level facade
	// point at this configuration so callers that don't go through
	// `createMemoryStore` still get the right backend.
	configureRawMessageStore(config);

	// Mutable wiring shared between the write path (`reflectWithPlan`) and the
	// opt-in `attachMemoryGraphStore` helper. A holder object (rather than two
	// captured `const`s) is required so that `attachMemoryGraphStore` — which
	// assigns `store.graphStore` — actually changes what `reflectWithPlan`
	// forwards. Previously it only overwrote a dead property and the attached
	// graph store was silently ignored, leaving `reflectWithPlan` in
	// deprecate-only mode no matter what.
	const wiring: {
		graphStore?: import("@melandlabs/memory-consolidation").MemoryGraphStoreWithOperationHistory;
		storage?: import("@melandlabs/memory-consolidation").MemoryStorageAdapterLike;
	} = {
		graphStore: config.graphStore,
		storage: config.storage,
	};

	// VSA facade — lazily open the SQLite VSA store. Shares the same DB
	// file as the raw-message store, so `init()` is a no-op if the schema
	// has already been brought up by `raw.init()`. Resolve the DB path
	// here because `getSQLiteVsaStore` lives in `@melandlabs/sqlite`
	// (which `memory-store` depends on) and can't import the env-aware
	// `resolveSQLiteRawMessageDbPath` helper without forming a cycle.
	const vsaDbPath =
		config.dbPath ??
		(config.db && "path" in config.db ? (config.db as { path?: string }).path : undefined) ??
		resolveSQLiteRawMessageDbPath();
	const vsaStorage: SQLiteVsaStore = await getSQLiteVsaStore({
		dbPath: vsaDbPath,
	});
	const vsa = createVsaRecall(vsaStorage);

	const store: MemoryStore = {
		raw,
		search,
		vsa,
		getRawMessageManager,
		searchUnifiedMemory: search.searchUnifiedMemory,
		searchRawMemorySemantically: search.searchRawMemorySemantically,
		reflect: search.reflect,
		reflectWithPlan: (input: ApplyReflectInput) =>
			search.reflectWithPlan({
				...input,
				graphStore: input.graphStore ?? wiring.graphStore,
				storage: input.storage ?? wiring.storage,
			}),
		get graphStore() {
			return wiring.graphStore;
		},
		set graphStore(value) {
			wiring.graphStore = value;
		},
		get storage() {
			return wiring.storage;
		},
		set storage(value) {
			wiring.storage = value;
		},
	};

	return store;
}

export type { MemoryStoreConfig };
export {
	createRawMessageStore,
	getRawMessageManager,
	isRawMessageStorageAvailable,
	getRawMessageStorageBackend,
	closeRawMessageStore,
	type RawMessageStorageBackend,
	type RawMessageStorageManagerWithSearch,
} from "./storage/raw-message-store";
export {
	registerPostgresFactory,
	clearPostgresFactory,
	hasPostgresFactory,
	resolvePostgresFactory,
	type PostgresFactoryFn,
	type PostgresRawMessageManagerLike,
} from "./storage/postgres-raw-message-factory";
export {
	createUnifiedSearch,
	type UnifiedSearch,
} from "./search/unified-search";
export {
	type ApplyReflectInput,
	type ApplyReflectOutput,
	applyReflectedPlan,
} from "./search/apply-reflect";
export {
	type AttachMemoryGraphStoreInput,
	attachMemoryGraphStore,
} from "./memory-store-graph";
export type {
	UnifiedMemorySearchInput,
	UnifiedMemorySearchOutput,
	UnifiedMemorySearchResult,
	UnifiedMemorySearchSource,
	UnifiedMemorySearchWarning,
	UnifiedMemoryReasoningStrategy,
	UnifiedMemoryReasoningInfo,
} from "./search/utilities";
export type {
	SearchInput,
	SearchOutput,
	SearchSource,
	SearchTier,
	SearchEvidence,
	UnifiedMemoryMergeStrategy,
	UnifiedMemoryRankedList,
} from "./search/utilities";
export { mergeUnifiedMemorySearchResultsRrf } from "./search/utilities";
export {
	clampUnifiedMemorySearchLimit,
	clampUnifiedMemorySearchThreshold,
	isRawMemorySemanticResult,
	mergeUnifiedMemorySearchResults,
	normalizeUnifiedMemoryReasoningStrategy,
	normalizeUnifiedMemorySearchSources,
	toKnowledgeResult,
	toMemoryResult,
} from "./search/utilities";
export {
	createUserVoiceRewriter,
	createIdentityRewriter,
	type QueryRewriter,
	type QueryRewriterInput,
	type QueryRewriterOptions,
} from "./search/query-rewriter";
export {
	createIterativeRecallPlanner,
	createIdentityIterativePlanner,
	type IterativeRecallCandidate,
	type IterativeRecallExecutor,
	type IterativeRecallPlanner,
	type IterativeRecallPlannerOptions,
	type IterativeRecallResult,
	type IterativeRecallSearchRequest,
	type IterativeRecallSearchResult,
	type IterativeRecallStats,
} from "./search/iterative-recall";
export {
	createPeerProfile,
	type PeerProfile,
	type PeerRelationship,
	type PeerProfileDeps,
	type PeerPosting,
	type PeerProfileFacade,
} from "./search/peer-profile";
export type {
	MemoryStoreDb,
	MemoryStoreEnv,
	VectorBackend,
	EmbedQueryFn,
	UnifiedSearchKnowledgeResult,
	UnifiedSearchInsightsResult,
	UnifiedSearchReasoningDeps,
} from "./config";
export type { RawMessage } from "./config";
export {
	createVsaRecall,
	type VsaRecallFacade,
} from "./search/vsa";
export type {
	StoreVsaFactInput,
	StoreVsaFactOutput,
	VsaFact,
	VsaFactSummary,
	VsaFactStorage,
	VsaForgetInput,
	VsaForgetOutput,
	VsaListInput,
	VsaRecallInput,
	VsaRecallOutput,
	VsaRecallScore,
	VsaVocabularyEntry,
} from "@melandlabs/contracts";
export {
	getSQLiteVsaStore,
	closeSQLiteVsaStore,
	type SQLiteVsaStore,
	type SQLiteVsaStoreOptions,
} from "@melandlabs/sqlite";
