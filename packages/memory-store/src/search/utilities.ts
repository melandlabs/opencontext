/**
 * Pure helpers used by the unified memory search pipeline.
 *
 * Kept side-effect free so they can be reused by tests, MCP tools,
 * and the HTTP daemon without pulling in any of the heavier
 * storage/search implementations.
 */

export type UnifiedMemorySearchSource = "memory" | "insights" | "knowledge";

export type UnifiedMemoryReasoningStrategy = "none" | "rewrite" | "iterative";

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
	 * How to merge per-source result lists. Defaults to `"similarity"` —
	 * the legacy global sort by similarity, then type/id tie-break. The
	 * alternate value `"rrf"` invokes reciprocal-rank fusion across the
	 * lists fed via the (internal) `rankedLists` option.
	 */
	mergeStrategy?: UnifiedMemoryMergeStrategy;
	/**
	 * Optional reasoning strategy. `"rewrite"` rewrites the query before
	 * embedding; `"iterative"` runs an LLM planner that searches, notes
	 * evidence, and searches again. Defaults to `"none"`.
	 */
	reasoningStrategy?: UnifiedMemoryReasoningStrategy;
}

export type UnifiedMemoryMergeStrategy = "similarity" | "rrf";

/**
 * A single ranked list from one retrieval channel. Used by the RRF merge to
 * combine multiple signals (semantic + lexical + insights + knowledge) without
 * flattening them into a single similarity score first.
 */
export interface UnifiedMemoryRankedList {
	name: "memory-bm25" | "memory-semantic" | "insights" | "knowledge";
	hits: UnifiedMemorySearchResult[];
}

export interface UnifiedMemorySearchResult {
	type: "memory" | "insight" | "knowledge";
	id: string;
	content: string;
	similarity: number;
	metadata: Record<string, unknown>;
}

export interface UnifiedMemorySearchOutput {
	query: string;
	sources: UnifiedMemorySearchSource[];
	results: UnifiedMemorySearchResult[];
	count: number;
	warnings: UnifiedMemorySearchWarning[];
	/**
	 * Diagnostic information about reasoning and date filtering. Present
	 * when (a) a non-`"none"` reasoning strategy was requested, or (b) a
	 * `dateFrom` / `dateTo` filter was applied to the memory source.
	 */
	reasoning?: UnifiedMemoryReasoningInfo;
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
	if (value === "rewrite" || value === "iterative") {
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
