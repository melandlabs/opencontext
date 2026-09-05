/**
 * Pure helpers used by the unified memory search pipeline.
 *
 * Kept side-effect free so they can be reused by tests, MCP tools,
 * and the HTTP daemon without pulling in any of the heavier
 * storage/search implementations.
 */

import type { FactType } from "@melandlabs/contracts";
import type { Peer } from "@melandlabs/contracts/peer";

export type UnifiedMemorySearchSource = "memory" | "insights" | "knowledge";

/**
 * A retrieval channel that contributed to a hit's final score.
 *
 *   - `semantic` — dense embedding lookup (`searchRawMessagesAnn` or
 *     the SQLite manager's semantic-search fallback).
 *   - `lexical`  — BM25 / FTS5 keyword match
 *     (`searchRawMessagesLexical` or the SQLite manager's lexical
 *     fallback).
 *   - `entity`   — entity-link match supplied by the host's
 *     `entitySearch` dep.
 */
export type HitChannel = "semantic" | "lexical" | "hybrid" | "entity";

/**
 * Per-hit score breakdown. Always emitted by `search()` (default merge
 * strategy) so callers can threshold / re-rank without losing the
 * individual channel contributions. The RRF fusion additionally
 * populates `signals.rrf` and continues to mirror the fused score
 * onto `metadata.rrfScore` (legacy field).
 *
 * Each numeric field is the raw per-channel score for the *first*
 * (highest-ranked) appearance of the same `(type, id)` key in the
 * channel's list. Channels that did not contribute are `undefined`.
 */
export interface HitSignals {
	/** Channels the hit actually appeared in. */
	channels: HitChannel[];
	/** Semantic sub-query similarity in [0..1] (undefined when absent). */
	semantic?: number;
	/** Lexical sub-query BM25 score (undefined when absent). */
	lexical?: number;
	/** Native backend dense+BM25 fused score (undefined when absent). */
	hybrid?: number;
	/** Entity sub-query match score (undefined when absent). */
	entity?: number;
	/** RRF-fused score (only when mergeStrategy === "rrf"). */
	rrf?: number;
}

/**
 * Closed enumeration of every supported `HitChannel`. Exported so
 * callers can iterate channels (e.g. when building a custom
 * per-channel re-ranker or a UI legend) without re-declaring the
 * list. Order is intentional — it matches the declaration order
 * used by `materializeSignals` when populating `signals.channels`.
 */
export const HIT_CHANNELS: readonly HitChannel[] = ["semantic", "lexical", "hybrid", "entity"] as const;

/**
 * Derive simple lexical keywords from a query string. Splits on any
 * non-letter/non-digit Unicode boundary, lowercases, drops tokens
 * shorter than 2 chars, and caps the list at 16. Used by the unified
 * search lexical sub-query and by the `derive` primitive's candidate
 * fetch fallback.
 */
export function deriveLexicalKeywords(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length >= 2)
		.slice(0, 16);
}

export type UnifiedMemoryReasoningStrategy = "none" | "rewrite" | "iterative" | "union";

export interface UnifiedMemorySearchWarning {
	source: UnifiedMemorySearchSource;
	code: string;
	message: string;
}

export interface UnifiedMemoryReasoningInfo {
	strategy: UnifiedMemoryReasoningStrategy;
	/**
	 * True when the caller asked for a non-`"none"` strategy but the
	 * corresponding reasoning provider was not configured (or its LLM
	 * call failed), so the unified search silently fell back to the default
	 * one-shot semantic + lexical path. Callers can use this to surface a
	 * degraded-mode warning to their users.
	 */
	degraded?: boolean;
	/** Query variants produced by the rewriter (original + rewritten). */
	rewrittenQueries?: string[];
	/** Number of planner iterations executed (iterative mode only). */
	iterations?: number;
	/** Number of evidence items collected by the planner (iterative mode only). */
	evidenceCount?: number;
	/** Date range that was applied to the memory source, if any. */
	dateRange?: { from?: string; to?: string };
}

export interface UnifiedMemorySearchInput {
	userId: string;
	query: string;
	sources?: UnifiedMemorySearchSource[];
	limit?: number;
	threshold?: number;
	authToken?: string;
	includeArchivedInsights?: boolean;
	botIds?: string[];
	documentIds?: string[];
	/**
	 * Optional ISO-8601 timestamp. When set, graph-aware retrieval and other
	 * snapshot consumers drop nodes / edges whose `applicability.validFrom` /
	 * `validUntil` window is closed at that instant. Backward-compatible:
	 * omitted `asOf` keeps the legacy behaviour exactly.
	 *
	 * This is a single-point snapshot, not a date range. For interval filtering
	 * over memory timestamps use `dateFrom` / `dateTo`.
	 */
	asOf?: string;
	/**
	 * Optional inclusive start date (ISO-8601). When set, the memory source
	 * filters out candidates whose timestamp is before this boundary. The
	 * iterative planner also receives this bound and may emit narrower ranges.
	 *
	 * This only affects the `memory` source; `insights` and `knowledge` are
	 * not filtered by this range. Candidates without a recognised timestamp are
	 * retained.
	 */
	dateFrom?: string;
	/**
	 * Optional inclusive end date (ISO-8601). When set, the memory source
	 * filters out candidates whose timestamp is after this boundary. Date-only
	 * strings are treated as the end of that day.
	 *
	 * This only affects the `memory` source; `insights` and `knowledge` are
	 * not filtered by this range. Candidates without a recognised timestamp are
	 * retained.
	 */
	dateTo?: string;
	/**
	 * How to merge per-source result lists. Defaults to `"rrf"` reciprocal-rank
	 * fusion. `"similarity"` preserves the legacy global similarity sort.
	 */
	mergeStrategy?: UnifiedMemoryMergeStrategy;
	/**
	 * Optional additive scope-narrowing filter expressed as structured
	 * peers. Coexists with `userId`/`botIds`. When supplied, the host's
	 * `UnifiedSearchDeps.peerScopeCheck` is consulted; peers that fall
	 * outside `userId` are dropped with a `peer_filter_outside_user_scope`
	 * warning rather than broadening the scope.
	 */
	peerFilter?: ReadonlyArray<Peer>;
	/**
	 * Optional reasoning strategy. `"rewrite"` rewrites the query before
	 * embedding; `"iterative"` runs an LLM planner that searches, notes
	 * evidence, and searches again. Defaults to `"none"`.
	 */
	reasoningStrategy?: UnifiedMemoryReasoningStrategy;
	/**
	 * Optional `FactType` read-side filter. When supplied, the memory
	 * source narrows candidates to rows whose `factType` is in this set.
	 * Only affects the `memory` source; `insights` and `knowledge` are
	 * not filtered by this. Empty array is treated as "no filter" so
	 * callers can pass `searchInput.factTypes ?? []` without surprises.
	 */
	factTypes?: FactType[];
	/** Include pre-fusion channel candidates in the response for diagnostics. */
	includeRetrievalDiagnostics?: boolean;
}

export type UnifiedMemoryMergeStrategy = "similarity" | "rrf";

/**
 * A single ranked list from one retrieval channel. Used by the RRF merge to
 * combine multiple signals (semantic + lexical + insights + knowledge) without
 * flattening them into a single similarity score first.
 */
export interface UnifiedMemoryRankedList {
	/** Label for the source list (e.g. a tier or channel). Free-form; the
	 * RRF fusion only reads `hits`, so `name` is purely diagnostic. */
	name: string;
	hits: UnifiedMemorySearchResult[];
}

export interface UnifiedMemorySearchResult {
	type: "memory" | "insight" | "knowledge";
	id: string;
	content: string;
	similarity: number;
	metadata: Record<string, unknown>;
	/**
	 * Optional per-channel score breakdown. Always populated by the
	 * pipeline when at least one channel contributed a non-empty list;
	 * callers should treat absence as "no channel info available".
	 */
	signals?: HitSignals;
}

export interface UnifiedMemorySearchOutput {
	query: string;
	sources: UnifiedMemorySearchSource[];
	results: UnifiedMemorySearchResult[];
	count: number;
	warnings: UnifiedMemorySearchWarning[];
	retrievalDiagnostics?: UnifiedMemoryRetrievalDiagnostics;
	/**
	 * Diagnostic information about reasoning and date filtering. Present
	 * when (a) a non-`"none"` reasoning strategy was requested, or (b) a
	 * `dateFrom` / `dateTo` filter was applied to the memory source.
	 */
	reasoning?: UnifiedMemoryReasoningInfo;
}

export interface UnifiedMemoryRetrievalDiagnostics {
	mergeStrategy: UnifiedMemoryMergeStrategy;
	candidateLimit: number;
	backend?: string;
	semanticDegradedReason?: string;
	candidateCounts?: {
		semantic: number;
		lexical: number;
		hybrid: number;
		entity: number;
		fused: number;
		final: number;
	};
	channels: {
		semantic: UnifiedMemorySearchResult[];
		lexical: UnifiedMemorySearchResult[];
		hybrid?: UnifiedMemorySearchResult[];
		entity?: UnifiedMemorySearchResult[];
	};
	/** Results after channel/source fusion and before an optional host reranker. */
	fusedBeforeRerank: UnifiedMemorySearchResult[];
	reranker?: {
		enabled: boolean;
		provider?: string;
		model?: string;
		inputCount: number;
		outputCount: number;
		latencyMs: number;
		orderChanged: boolean;
	};
	/** Final results after optional reranking and Top-K truncation. */
	final: UnifiedMemorySearchResult[];
}

// ─── Unified `store.search()` public surface ──────────────────────────────────
//
// The read-side search input/output plumbing is preserved as the
// underlying contract for cross-source retrieval, date filtering, RRF
// merge, and reasoning strategies. The top-level `store.search(input)`
// verb is built on top of it. The new `SearchInput`/`SearchOutput` types
// are additive and kept backward-compatible with the internal callers.

/**
 * Cross-source retrieval surface for the unified search. Mirrors
 * `UnifiedMemorySearchSource` but is exposed under a more discoverable
 * name.
 */
export type SearchSource = UnifiedMemorySearchSource;

/**
 * Per-tier evidence bucket consulted by `reflect`-style synthesis.
 * Includes the `summary` tier that the read-only sources do not surface.
 */
export type SearchTier = "summary" | "raw" | "insight" | "knowledge";

export interface SearchInput {
	userId: string;
	query: string;

	/** Cross-source retrieval surface (defaults to all three sources). */
	sources?: ReadonlyArray<SearchSource>;

	/**
	 * Per-tier subset — when omitted, defaults to all four tiers.
	 * Forwarded to the gather step so the read pipeline can scope the
	 * evidence. Most callers pass nothing; `synthesize` callers can
	 * narrow to `["raw"]` or `["summary", "raw"]` for cheaper synthesis.
	 */
	tiers?: ReadonlyArray<SearchTier>;

	/**
	 * Opt-in LLM synthesis. When `true`, runs `reasoning.complete` after
	 * gathering evidence and returns `answer` in the output. When
	 * omitted / `false`, no LLM call is made (matches today's
	 * `searchUnifiedMemory`). The `responseSchema` form lets the LLM
	 * return JSON; the SDK extracts `{ answer: string }` from the
	 * payload and surfaces the rest via warnings.
	 */
	synthesize?: boolean | { responseSchema?: Record<string, unknown> };

	limit?: number;
	threshold?: number;
	botIds?: string[];
	documentIds?: string[];
	dateFrom?: string;
	dateTo?: string;
	asOf?: string;
	peerFilter?: ReadonlyArray<Peer>;
	authToken?: string;
	factTypes?: FactType[];
	mergeStrategy?: UnifiedMemoryMergeStrategy;
	reasoningStrategy?: UnifiedMemoryReasoningStrategy;
	/**
	 * Backward-compat pass-through for callers that previously passed
	 * `responseSchema` at the top level. When set, it overrides
	 * `synthesize.responseSchema`.
	 */
	responseSchema?: Record<string, unknown>;
	/**
	 * Backward-compat pass-through for callers that previously passed
	 * `includeArchivedInsights` to the read-only search.
	 */
	includeArchivedInsights?: boolean;
	/** Include pre-fusion retrieval candidates; intended for evaluation/debugging. */
	includeRetrievalDiagnostics?: boolean;
}

export interface SearchEvidence {
	id: string;
	source: SearchSource | SearchTier;
	snippet: string;
	score: number;
	timestamp?: number;
}

export interface SearchOutput {
	query: string;
	sources: ReadonlyArray<SearchSource>;
	results: UnifiedMemorySearchResult[];
	/** Same hits as `results`, with the source labelled for synthesis callers. */
	evidence: SearchEvidence[];
	count: number;
	warnings: UnifiedMemorySearchWarning[];
	retrievalDiagnostics?: UnifiedMemoryRetrievalDiagnostics;
	reasoning?: UnifiedMemoryReasoningInfo;
	/** Only present when `synthesize` was truthy. */
	answer?: string;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_SOURCES: UnifiedMemorySearchSource[] = ["memory", "insights", "knowledge"];
const SOURCE_SET = new Set<UnifiedMemorySearchSource>(DEFAULT_SOURCES);

export function normalizeUnifiedMemorySearchSources(sources: unknown): UnifiedMemorySearchSource[] {
	if (!Array.isArray(sources) || sources.length === 0) {
		return [...DEFAULT_SOURCES];
	}

	const normalized = sources
		.filter((source): source is string => typeof source === "string")
		.map((source) => source.trim().toLowerCase())
		.filter((source): source is UnifiedMemorySearchSource =>
			SOURCE_SET.has(source as UnifiedMemorySearchSource),
		);

	return normalized.length > 0 ? Array.from(new Set(normalized)) : [...DEFAULT_SOURCES];
}

export function clampUnifiedMemorySearchLimit(limit: unknown): number {
	const parsed = typeof limit === "number" ? limit : Number(limit ?? DEFAULT_LIMIT);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_LIMIT;
	}
	return Math.min(50, Math.max(1, Math.floor(parsed)));
}

export function clampUnifiedMemorySearchThreshold(threshold: unknown): number {
	const parsed = typeof threshold === "number" ? threshold : Number(threshold ?? DEFAULT_THRESHOLD);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_THRESHOLD;
	}
	return Math.min(1, Math.max(-1, parsed));
}

export function mergeUnifiedMemorySearchResults(
	results: UnifiedMemorySearchResult[],
	limit: number,
	options: { strategy?: UnifiedMemoryMergeStrategy; rankedLists?: UnifiedMemoryRankedList[] } = {},
): UnifiedMemorySearchResult[] {
	const strategy = normalizeUnifiedMemoryMergeStrategy(options.strategy);
	if (strategy === "rrf") {
		const lists: UnifiedMemoryRankedList[] = options.rankedLists ?? [
			{ name: "memory-semantic", hits: results },
		];
		return mergeUnifiedMemorySearchResultsRrf(lists, limit);
	}
	return [...results]
		.sort((a, b) => {
			const scoreDelta = b.similarity - a.similarity;
			if (scoreDelta !== 0) {
				return scoreDelta;
			}
			return a.type.localeCompare(b.type) || a.id.localeCompare(b.id);
		})
		.slice(0, limit);
}

export function normalizeUnifiedMemoryMergeStrategy(value: unknown): UnifiedMemoryMergeStrategy {
	return value === "rrf" ? "rrf" : "similarity";
}

export function normalizeUnifiedMemoryReasoningStrategy(
	value: unknown,
	defaultStrategy: UnifiedMemoryReasoningStrategy = "none",
): UnifiedMemoryReasoningStrategy {
	if (value === "rewrite" || value === "iterative" || value === "union") {
		return value;
	}
	return defaultStrategy;
}

const DEFAULT_RRF_K = 60;

/**
 * Reciprocal Rank Fusion across multiple ranked lists. Each list contributes
 * `1 / (k + rank + 1)` to a hit's accumulated score. Hits are de-duplicated by
 * `(type, id)` so the same message surfaced by both lexical and semantic
 * channels naturally outranks single-channel matches. Tie-break is
 * deterministic: descending RRF score, then `(type, id)` lexical.
 */
export function mergeUnifiedMemorySearchResultsRrf(
	lists: UnifiedMemoryRankedList[],
	limit: number,
	k: number = DEFAULT_RRF_K,
): UnifiedMemorySearchResult[] {
	if (!Array.isArray(lists) || lists.length === 0) {
		return [];
	}
	const safeK = Number.isFinite(k) && k > 0 ? k : DEFAULT_RRF_K;
	const scores = new Map<string, { hit: UnifiedMemorySearchResult; rrf: number }>();
	const order: string[] = [];

	for (const list of lists) {
		for (let index = 0; index < list.hits.length; index += 1) {
			const hit = list.hits[index];
			const key = `${hit.type}::${hit.id}`;
			const contribution = 1 / (safeK + index + 1);
			const existing = scores.get(key);
			if (existing) {
				existing.rrf += contribution;
			} else {
				scores.set(key, { hit, rrf: contribution });
				order.push(key);
			}
		}
	}

	const ranked = order
		.map((key) => {
			const entry = scores.get(key);
			if (!entry) {
				throw new Error(`Invariant violation: missing RRF score for key "${key}"`);
			}
			return entry;
		})
		.sort((a, b) => {
			if (b.rrf !== a.rrf) {
				return b.rrf - a.rrf;
			}
			return a.hit.type.localeCompare(b.hit.type) || a.hit.id.localeCompare(b.hit.id);
		})
		.slice(0, limit);

	return ranked.map(({ hit, rrf }) => ({
		...hit,
		metadata: { ...hit.metadata, rrfScore: rrf },
	}));
}

export function toKnowledgeResult(result: {
	chunkId: string;
	documentId: string;
	documentName: string;
	content: string;
	similarity: number;
	chunkIndex: number;
}): UnifiedMemorySearchResult {
	return {
		type: "knowledge",
		id: result.chunkId,
		content: result.content,
		similarity: result.similarity,
		metadata: {
			documentId: result.documentId,
			documentName: result.documentName,
			chunkIndex: result.chunkIndex,
		},
	};
}

export function toMemoryResult(result: {
	id: string;
	content: string;
	similarity: number;
	metadata: Record<string, unknown>;
}): UnifiedMemorySearchResult {
	return {
		type: "memory",
		id: result.id,
		content: result.content,
		similarity: result.similarity,
		metadata: result.metadata,
	};
}

/**
 * Build the `signals` breakdown for a single hit from the per-channel
 * ranked lists it appeared in. Only the highest-ranked (i.e. first)
 * appearance of `(type, id)` per channel contributes — duplicate hits
 * later in the same list are ignored so the breakdown stays
 * deterministic.
 *
 * Used by `mergeAcrossSources` to attach `signals` to every emitted
 * `UnifiedMemorySearchResult`. Pure; no I/O.
 */
export function materializeSignals(
	lists: ReadonlyArray<{ name: string; hits: UnifiedMemorySearchResult[] }>,
	hit: UnifiedMemorySearchResult,
): HitSignals | undefined {
	const channels: HitChannel[] = [];
	let semantic: number | undefined;
	let lexical: number | undefined;
	let entity: number | undefined;

	for (const list of lists) {
		const channel = listNameToChannel(list.name);
		if (!channel) continue;
		if (channels.includes(channel)) continue;
		// Scan for the first occurrence of `(type, id)` in the list. The
		// lists are short (≤ limit) so linear scan is fine here.
		let found: UnifiedMemorySearchResult | undefined;
		for (const candidate of list.hits) {
			if (candidate.type === hit.type && candidate.id === hit.id) {
				found = candidate;
				break;
			}
		}
		if (!found) continue;
		channels.push(channel);
		if (channel === "semantic" && semantic === undefined) {
			semantic = found.similarity;
		} else if (channel === "lexical" && lexical === undefined) {
			lexical = found.similarity;
		} else if (channel === "entity" && entity === undefined) {
			entity = found.similarity;
		}
	}

	if (channels.length === 0) {
		return undefined;
	}

	const out: HitSignals = { channels };
	if (semantic !== undefined) out.semantic = semantic;
	if (lexical !== undefined) out.lexical = lexical;
	if (entity !== undefined) out.entity = entity;
	if (typeof hit.metadata.rrfScore === "number") {
		out.rrf = hit.metadata.rrfScore;
	}
	return out;
}

/**
 * Map a `UnifiedMemoryRankedList.name` to a `HitChannel`. Unknown names
 * (e.g. "insights", "knowledge", "summary") are not channels — they
 * surface their similarity through the merge's `similarity` field and
 * are simply skipped here so callers can still see which channel set
 * the hit came from.
 */
export function listNameToChannel(name: string): HitChannel | undefined {
	if (name === "memory-semantic") return "semantic";
	if (name === "memory-bm25" || name === "memory-lexical") return "lexical";
	if (name === "memory-hybrid") return "hybrid";
	if (name === "memory-entity") return "entity";
	return undefined;
}

export function isRawMemorySemanticResult(result: unknown): result is {
	id: string;
	content: string;
	similarity: number;
	metadata: Record<string, unknown>;
} {
	if (!result || typeof result !== "object") {
		return false;
	}
	const item = result as Record<string, unknown>;
	return (
		typeof item.id === "string" &&
		typeof item.content === "string" &&
		typeof item.similarity === "number" &&
		Boolean(item.metadata) &&
		typeof item.metadata === "object"
	);
}

export interface ResolvedPeerScope {
	/** Peers to apply to the underlying retrieval (never wider than userId). */
	peers: ReadonlyArray<Peer>;
	/** Warnings to surface when the input was over-broad or empty. */
	warnings: UnifiedMemorySearchWarning[];
}

/**
 * Resolve a `peerFilter` against the active `userId`. The returned
 * `peers` is always a strict narrowing — never broader than `userId`.
 *
 *   - Empty input → `{ peers: [], warnings: [] }` (legacy behaviour).
 *   - All peers pass the host's `peerScopeCheck` → return as-is.
 *   - Any peer fails `peerScopeCheck` → emit a `peer_filter_outside_user_scope`
 *     warning and drop the offending peers. If every peer is dropped, the
 *     search falls back to the unfiltered `userId` scope (with warning).
 */
export async function resolveScopePeer(input: {
	userId: string;
	peerFilter: ReadonlyArray<Peer> | undefined;
	scopeCheck?: (input: { userId: string; peers: ReadonlyArray<Peer> }) => Promise<boolean> | boolean;
}): Promise<ResolvedPeerScope> {
	const peers = input.peerFilter ?? [];
	if (peers.length === 0) {
		return { peers: [], warnings: [] };
	}
	if (typeof input.scopeCheck !== "function") {
		// No host-side check wired up: trust the caller's filter.
		return { peers, warnings: [] };
	}

	const retained: Peer[] = [];
	const dropped: Peer[] = [];
	for (const peer of peers) {
		const ok = await input.scopeCheck({ userId: input.userId, peers: [peer] });
		if (ok) {
			retained.push(peer);
		} else {
			dropped.push(peer);
		}
	}

	if (dropped.length === 0) {
		return { peers, warnings: [] };
	}

	if (retained.length === 0) {
		return {
			peers: [],
			warnings: [
				{
					source: "memory",
					code: "peer_filter_outside_user_scope",
					message: `${dropped
						.map((peer) => `${peer.kind}:${peer.id}`)
						.join(",")} ignored; falling back to userId scope`,
				},
			],
		};
	}

	return {
		peers: retained,
		warnings: [
			{
				source: "memory",
				code: "peer_filter_outside_user_scope",
				message: `${dropped
					.map((peer) => `${peer.kind}:${peer.id}`)
					.join(",")} ignored because they fall outside userId ${input.userId}`,
			},
		],
	};
}
