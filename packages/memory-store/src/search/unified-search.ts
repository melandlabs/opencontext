/**
 * Unified semantic search facade.
 *
 * Cross-source search over raw messages (always), insights, and
 * uploaded knowledge documents. The host wires up the cross-domain
 * dependencies via `UnifiedSearchDeps` so this module stays
 * framework-agnostic.
 *
 * The public entry point is `search(input)` — a single method. Set
 * `synthesize: true` to opt into the LLM synthesis step.
 */

import type { Peer } from "@melandlabs/contracts/peer";
import type { UnifiedSearchDeps } from "../config";
import { isRawMessageStorageAvailable } from "../storage/raw-message-store";
import { type ApplyConsolidateInput, type ApplyConsolidateOutput, applyReflectedPlan } from "./apply-reflect";
import { gatherSummaries, resolveSearchScopePeers, synthesizeAnswer } from "./gather-evidence";
import type {
	IterativeRecallCandidate,
	IterativeRecallSearchRequest,
	IterativeRecallSearchResult,
} from "./iterative-recall";
import { applyReranker } from "./reranker";
import {
	type SearchEvidence,
	type SearchInput,
	type SearchOutput,
	type SearchSource,
	type SearchTier,
	type UnifiedMemoryMergeStrategy,
	type UnifiedMemoryRankedList,
	type UnifiedMemoryReasoningInfo,
	type UnifiedMemoryReasoningStrategy,
	type UnifiedMemorySearchInput,
	type UnifiedMemorySearchOutput,
	type UnifiedMemorySearchResult,
	type UnifiedMemorySearchSource,
	type UnifiedMemorySearchWarning,
	clampUnifiedMemorySearchLimit,
	clampUnifiedMemorySearchThreshold,
	deriveLexicalKeywords,
	isRawMemorySemanticResult,
	materializeSignals,
	mergeUnifiedMemorySearchResults,
	mergeUnifiedMemorySearchResultsRrf,
	normalizeUnifiedMemoryMergeStrategy,
	normalizeUnifiedMemoryReasoningStrategy,
	normalizeUnifiedMemorySearchSources,
	resolveScopePeer,
	toKnowledgeResult,
	toMemoryResult,
} from "./utilities";

export type {
	HitChannel,
	HitSignals,
	UnifiedMemoryMergeStrategy,
	UnifiedMemoryRankedList,
	UnifiedMemoryReasoningStrategy,
	UnifiedMemorySearchInput,
	UnifiedMemorySearchOutput,
	UnifiedMemorySearchResult,
	UnifiedMemorySearchSource,
	UnifiedMemorySearchWarning,
	SearchInput,
	SearchOutput,
	SearchSource,
	SearchTier,
	SearchEvidence,
} from "./utilities";

export {
	clampUnifiedMemorySearchLimit,
	clampUnifiedMemorySearchThreshold,
	deriveLexicalKeywords,
	isRawMemorySemanticResult,
	listNameToChannel,
	materializeSignals,
	mergeUnifiedMemorySearchResults,
	mergeUnifiedMemorySearchResultsRrf,
	normalizeUnifiedMemoryMergeStrategy,
	normalizeUnifiedMemoryReasoningStrategy,
	normalizeUnifiedMemorySearchSources,
	toKnowledgeResult,
	toMemoryResult,
} from "./utilities";

export interface UnifiedSearch {
	/**
	 * Single unified read entry point. Set `synthesize: true` to opt into
	 * LLM synthesis.
	 */
	search(input: SearchInput): Promise<SearchOutput>;
	/**
	 * @deprecated Use `search(input)` instead. Forwarding shim kept for
	 * one release window.
	 */
	searchUnifiedMemory(input: UnifiedMemorySearchInput): Promise<UnifiedMemorySearchOutput>;
	/**
	 * @deprecated Use `search({ ...input, sources: ["memory"] })` and
	 * read `.results` instead.
	 */
	searchRawMemorySemantically(input: UnifiedMemorySearchInput): Promise<UnifiedMemorySearchResult[]>;
	/**
	 * Agentic write-back: runs the same evidence pipeline as `search`,
	 * then builds a memory-consolidation plan, optionally asks the LLM
	 * to veto unsafe entries, and persists via the attached graph store
	 * (when present) + soft-deprecates superseded records via the storage
	 * adapter. See `./apply-reflect.ts` for the contract and degradation
	 * rules.
	 */
	consolidate(input: ApplyConsolidateInput): Promise<ApplyConsolidateOutput>;
}

/**
 * Heuristic entity-keyword extractor: reuses the lexical tokenizer
 * and additionally pulls out capitalized proper-noun-shaped tokens
 * (≥ 3 chars, starting with an uppercase Latin letter). The intent is
 * to capture obvious named-entity mentions like "Luna", "Acme", "Berlin"
 * without committing to a full NER pipeline — the host's
 * `entitySearch` dep is responsible for any language-aware matching
 * beyond this surface.
 */
function deriveEntityKeywords(query: string): string[] {
	const proper = Array.from(new Set(query.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [])).map((w) => w.toLowerCase());
	const lexical = deriveLexicalKeywords(query);
	// Preserve order while deduplicating.
	const seen = new Set<string>();
	const out: string[] = [];
	for (const word of [...proper, ...lexical]) {
		if (word.length < 2) continue;
		if (seen.has(word)) continue;
		seen.add(word);
		out.push(word);
	}
	return out.slice(0, 16);
}

/**
 * Run the host's `entitySearch` sub-query and project the matches
 * back into `UnifiedMemorySearchResult[]` so the outer merge can fuse
 * them with semantic + lexical channels via RRF.
 *
 * Returns `[]` when no entity keywords can be derived (e.g. the query
 * is short, all-lowercase, or numeric).
 */
async function runEntitySearchForQuery(
	deps: UnifiedSearchDeps,
	input: UnifiedMemorySearchInput,
	limit: number,
	logger: Pick<Console, "warn">,
	peerPeers: ReadonlyArray<Peer> = [],
): Promise<UnifiedMemorySearchResult[]> {
	if (typeof deps.entitySearch !== "function") {
		return [];
	}
	const keywords = deriveEntityKeywords(input.query);
	if (keywords.length === 0) {
		return [];
	}
	try {
		const entitySearch = deps.entitySearch;
		const filters = input.botIds && input.botIds.length > 0 ? input.botIds : [undefined];
		const matches = (
			await Promise.all(
				filters.map((botId) =>
					entitySearch({
						userId: input.userId,
						keywords,
						limit: Math.ceil(limit / filters.length),
						botId,
						...(peerPeers.length > 0 ? { peers: peerPeers } : {}),
					}),
				),
			)
		).flat();
		return matches
			.filter(
				(m): m is { messageId: string; label: string; score: number } =>
					typeof m?.messageId === "string" && typeof m?.label === "string" && typeof m?.score === "number",
			)
			.map((m) => ({
				type: "memory" as const,
				id: m.messageId,
				// The host's `entitySearch` returns match ids + labels only,
				// so we surface the entity label as `content`. When the same
				// `messageId` is also returned by the semantic/lexical channel
				// (RRF path), the real message content is preserved via the
				// shared `(type, id)` key; otherwise callers can re-fetch the
				// original message by `id` (set in metadata as `sourceMessageId`).
				content: m.label,
				similarity: m.score,
				metadata: {
					scoring: "entity",
					entityLabel: m.label,
					isEntityProjection: true,
					sourceMessageId: m.messageId,
				},
			}));
	} catch (error) {
		logger.warn?.("[memory-store] entity search failed:", error);
		return [];
	}
}

function parseDateBoundary(value: string, role: "from" | "to"): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	// Date-only strings must be parsed in UTC to avoid timezone drift.
	// Date.parse("2024-05-15") treats the value as local midnight, which can
	// shift the boundary by the host offset.
	const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dateOnlyMatch) {
		const year = Number.parseInt(dateOnlyMatch[1], 10);
		const month = Number.parseInt(dateOnlyMatch[2], 10) - 1;
		const day = Number.parseInt(dateOnlyMatch[3], 10);
		if (role === "from") {
			return Date.UTC(year, month, day);
		}
		// Inclusive end of the day.
		return Date.UTC(year, month, day + 1) - 1;
	}

	const parsed = Date.parse(trimmed);
	if (Number.isNaN(parsed)) {
		return undefined;
	}
	return parsed;
}

function getCandidateTimestamp(metadata: Record<string, unknown>): number | undefined {
	for (const key of ["timestamp", "createdAt", "time"]) {
		const value = metadata[key];
		if (typeof value === "number") {
			return value;
		}
		if (typeof value === "string") {
			const parsed = Date.parse(value);
			if (!Number.isNaN(parsed)) {
				return parsed;
			}
		}
	}
	return undefined;
}

function filterByDateRange<T extends { metadata: Record<string, unknown> }>(
	items: T[],
	dateFrom?: string,
	dateTo?: string,
): T[] {
	if (!dateFrom && !dateTo) {
		return items;
	}

	const fromMs = dateFrom ? parseDateBoundary(dateFrom, "from") : undefined;
	const toMs = dateTo ? parseDateBoundary(dateTo, "to") : undefined;
	if (fromMs === undefined && toMs === undefined) {
		return items;
	}

	return items.filter((item) => {
		const ts = getCandidateTimestamp(item.metadata);
		if (ts === undefined) {
			return true;
		}
		if (fromMs !== undefined && ts < fromMs) {
			return false;
		}
		if (toMs !== undefined && ts > toMs) {
			return false;
		}
		return true;
	});
}

async function embedQueryVariant(
	embedQuery: NonNullable<UnifiedSearchDeps["embedQuery"]>,
	input: UnifiedMemorySearchInput,
	query: string,
): Promise<number[]> {
	return embedQuery({
		userId: input.userId,
		query,
		authToken: input.authToken,
	});
}

async function runSemanticSearchForEmbedding(
	deps: UnifiedSearchDeps,
	input: UnifiedMemorySearchInput,
	queryEmbedding: number[],
	limit: number,
	threshold: number,
	logger: Pick<Console, "log" | "warn">,
	peerPeers: ReadonlyArray<Peer> = [],
): Promise<UnifiedMemorySearchResult[]> {
	const filters = input.botIds && input.botIds.length > 0 ? input.botIds.map((botId) => ({ botId })) : [{}];
	let semantic: UnifiedMemorySearchResult[] = [];

	if (typeof deps.searchRawMessagesAnn === "function") {
		const searchRawMessagesAnn = deps.searchRawMessagesAnn;
		const factTypes = input.factTypes?.length ? input.factTypes : undefined;
		semantic = (
			await Promise.all(
				filters.map((filter) =>
					searchRawMessagesAnn({
						userId: input.userId,
						queryEmbedding,
						limit,
						threshold,
						botId: "botId" in filter ? filter.botId : undefined,
						...(peerPeers.length > 0 ? { peers: peerPeers } : {}),
						...(factTypes ? { factTypes } : {}),
					}),
				),
			)
		)
			.flat()
			.filter(isRawMemorySemanticResult)
			.map(toMemoryResult);
	}

	if (semantic.length === 0 && typeof deps.searchRawMessagesAnn !== "function") {
		try {
			const { getRawMessageManager } = await import("../storage/raw-message-store");
			const manager = await getRawMessageManager();
			if (typeof manager.searchMessagesSemantically === "function") {
				const factTypes = input.factTypes?.length ? input.factTypes : undefined;
				const results = await manager.searchMessagesSemantically({
					userId: input.userId,
					queryEmbedding,
					limit,
					threshold,
					...(peerPeers.length > 0 ? { peers: peerPeers } : {}),
					...(factTypes ? { factTypes } : {}),
				});
				semantic = (
					results as Array<{
						id: string;
						content: string;
						similarity: number;
						metadata?: Record<string, unknown>;
					}>
				).map((r) => ({
					type: "memory" as const,
					id: r.id,
					content: r.content,
					similarity: r.similarity,
					metadata: r.metadata ?? {},
				}));
			}
		} catch (error) {
			logger.warn?.("[memory-store] SQLite semantic search failed:", error);
		}
	}

	return semantic;
}

/**
 * Merge several ranked lists of `id`-keyed hits into a single list where each
 * id appears at most once, keeping the entry with the highest `similarity`.
 * Generic over the hit shape; both `UnifiedMemorySearchResult` and
 * `IterativeRecallCandidate` qualify without a wrapper.
 */
function mergeByMaxScore<T extends { id: string; similarity: number }>(lists: T[][]): T[] {
	const best = new Map<string, T>();
	for (const list of lists) {
		for (const hit of list) {
			const existing = best.get(hit.id);
			if (!existing || hit.similarity > existing.similarity) {
				best.set(hit.id, hit);
			}
		}
	}
	return Array.from(best.values()).sort((a, b) => b.similarity - a.similarity);
}

function dedupeChannelByParent(hits: UnifiedMemorySearchResult[]): UnifiedMemorySearchResult[] {
	const strongest = new Map<string, UnifiedMemorySearchResult>();
	for (const hit of hits) {
		const sourceMessageId = hit.metadata?.sourceMessageId;
		const parentId =
			typeof sourceMessageId === "string" && sourceMessageId.length > 0 ? sourceMessageId : hit.id;
		const normalized = hit.type === "memory" && hit.id !== parentId ? { ...hit, id: parentId } : hit;
		const key = `${normalized.type}:${parentId}`;
		const current = strongest.get(key);
		if (!current || normalized.similarity > current.similarity) strongest.set(key, normalized);
	}
	return [...strongest.values()].sort((a, b) => b.similarity - a.similarity);
}

function toIterativeRecallCandidate(hit: UnifiedMemorySearchResult): IterativeRecallCandidate {
	return {
		id: hit.id,
		content: hit.content,
		similarity: hit.similarity,
		metadata: hit.metadata,
	};
}

async function runLexicalSearchForKeywords(
	deps: UnifiedSearchDeps,
	input: UnifiedMemorySearchInput,
	keywords: string[],
	limit: number,
	logger: Pick<Console, "warn">,
	peerPeers: ReadonlyArray<Peer> = [],
): Promise<UnifiedMemorySearchResult[]> {
	if (keywords.length === 0) {
		return [];
	}

	if (typeof deps.searchRawMessagesLexical === "function") {
		try {
			const filters = input.botIds && input.botIds.length > 0 ? input.botIds : [undefined];
			const searchRawMessagesLexical = deps.searchRawMessagesLexical;
			const factTypes = input.factTypes?.length ? input.factTypes : undefined;
			return (
				await Promise.all(
					filters.map((botId) =>
						searchRawMessagesLexical({
							userId: input.userId,
							keywords,
							limit: Math.ceil(limit / filters.length),
							botId,
							...(peerPeers.length > 0 ? { peers: peerPeers } : {}),
							...(factTypes ? { factTypes } : {}),
						}),
					),
				)
			)
				.flat()
				.filter(isRawMemorySemanticResult)
				.map((hit) => ({
					...toMemoryResult(hit),
					metadata: { ...hit.metadata, scoring: "bm25" },
				}));
		} catch (error) {
			logger.warn?.("[memory-store] lexical memory search failed:", error);
		}
	}

	try {
		const { lexicalSearchRawMessages } = await import("../storage/sqlite-raw-message-store");
		const filters = input.botIds && input.botIds.length > 0 ? input.botIds : [undefined];
		const factTypes = input.factTypes?.length ? input.factTypes : undefined;
		return (
			await Promise.all(
				filters.map((botId) =>
					lexicalSearchRawMessages({
						userId: input.userId,
						keywords,
						limit: Math.ceil(limit / filters.length),
						botId,
						...(factTypes ? { factTypes } : {}),
					}),
				),
			)
		)
			.flat()
			.filter(Boolean)
			.map((r) =>
				toMemoryResult(
					r as { id: string; content: string; similarity: number; metadata: Record<string, unknown> },
				),
			);
	} catch (error) {
		logger.warn?.("[memory-store] SQLite lexical search failed:", error);
	}

	return [];
}

/**
 * Sub-query output for the memory source. Each retrieval channel is exposed
 * separately so the outer merge (similarity or RRF) can combine them without
 * losing channel identity.
 *
 * `entity` is optional — present only when the host wired
 * `unified.entitySearch` AND the query yielded at least one entity
 * keyword. Entity hits are fused into the final ranking ONLY under
 * `mergeStrategy:'rrf'` (rank fusion keeps the real message content and
 * avoids mixing the host-defined entity score with cosine/BM25 scales).
 * Under a similarity merge the standalone entity hits are suppressed and
 * a `memory_entity_requires_rrf` warning is emitted — only the `entity`
 * channel signal on co-occurring hits is retained.
 */
interface MemorySubQueries {
	semantic: UnifiedMemorySearchResult[];
	lexical: UnifiedMemorySearchResult[];
	hybrid?: UnifiedMemorySearchResult[];
	entity?: UnifiedMemorySearchResult[];
}

function searchInputToUnified(input: SearchInput): UnifiedMemorySearchInput {
	return {
		userId: input.userId,
		query: input.query,
		sources: input.sources ? [...input.sources] : undefined,
		limit: input.limit,
		threshold: input.threshold,
		authToken: input.authToken,
		includeArchivedInsights: input.includeArchivedInsights,
		botIds: input.botIds,
		documentIds: input.documentIds,
		asOf: input.asOf,
		dateFrom: input.dateFrom,
		dateTo: input.dateTo,
		mergeStrategy: input.mergeStrategy,
		peerFilter: input.peerFilter,
		reasoningStrategy: input.reasoningStrategy,
		factTypes: input.factTypes,
		includeRetrievalDiagnostics: input.includeRetrievalDiagnostics,
	};
}

function mapHitToEvidenceSource(hit: UnifiedMemorySearchResult): SearchSource | SearchTier {
	const tierMarker = (hit.metadata as Record<string, unknown> | undefined)?.tier;
	if (tierMarker === "summary") {
		return "summary";
	}
	if (hit.type === "memory") {
		return "raw";
	}
	if (hit.type === "insight") {
		return "insight";
	}
	if (hit.type === "knowledge") {
		return "knowledge";
	}
	return hit.type as SearchSource;
}

export function createUnifiedSearch(deps: UnifiedSearchDeps = {}): UnifiedSearch {
	const logger = deps.logger ?? console;

	function resolveReasoningStrategy(input: UnifiedMemorySearchInput): UnifiedMemoryReasoningStrategy {
		const requested = normalizeUnifiedMemoryReasoningStrategy(input.reasoningStrategy);
		if (requested !== "none") {
			return requested;
		}
		return normalizeUnifiedMemoryReasoningStrategy(deps.reasoning?.defaultStrategy, "none");
	}

	async function runMemorySource(
		input: UnifiedMemorySearchInput,
		limit: number,
		threshold: number,
		warnings: UnifiedMemorySearchWarning[],
		reasoningStrategy: UnifiedMemoryReasoningStrategy = "none",
		reasoningInfo?: UnifiedMemoryReasoningInfo,
		peerPeers: ReadonlyArray<Peer> = [],
	): Promise<MemorySubQueries> {
		if (
			(reasoningStrategy === "iterative" || reasoningStrategy === "union") &&
			!deps.reasoning?.iterativePlanner
		) {
			warnings.push({
				source: "memory",
				code: "memory_iterative_planner_not_configured",
				message:
					"Iterative reasoning requested but no iterativePlanner is configured; falling back to default search.",
			});
			if (reasoningInfo) reasoningInfo.degraded = true;
		}
		if (reasoningStrategy === "rewrite" && !deps.reasoning?.queryRewriter) {
			warnings.push({
				source: "memory",
				code: "memory_query_rewrite_not_configured",
				message:
					"Rewrite reasoning requested but no queryRewriter is configured; falling back to default search.",
			});
			if (reasoningInfo) reasoningInfo.degraded = true;
		}

		// Iterative reasoning bypasses the one-shot semantic/lexical path and lets
		// a planner model drive its own searches. The planner's executor runs a
		// hybrid search: lexical from the provided keywords plus semantic search
		// from an embedding of those keywords, so the planner benefits from both
		// exact matching and dense retrieval. The "union" strategy runs the same
		// planner but keeps its evidence and merges it with the baseline hybrid
		// result below instead of replacing it.
		let unionEvidence: UnifiedMemorySearchResult[] | null = null;
		if (
			(reasoningStrategy === "iterative" || reasoningStrategy === "union") &&
			deps.reasoning?.iterativePlanner
		) {
			const planner = deps.reasoning.iterativePlanner;
			const result = await planner.plan({
				query: input.query,
				dateFrom: input.dateFrom,
				dateTo: input.dateTo,
				executor: {
					search: async (request: IterativeRecallSearchRequest): Promise<IterativeRecallSearchResult> => {
						const keywords =
							request.keywords.length > 0 ? request.keywords : deriveLexicalKeywords(input.query);
						const lexicalHits = await runLexicalSearchForKeywords(
							deps,
							input,
							keywords,
							limit,
							logger,
							peerPeers,
						);

						let semanticHits: UnifiedMemorySearchResult[] = [];
						if (typeof deps.embedQuery === "function") {
							try {
								const semanticQuery = keywords.join(" ");
								const queryEmbedding = await embedQueryVariant(deps.embedQuery, input, semanticQuery);
								semanticHits = await runSemanticSearchForEmbedding(
									deps,
									input,
									queryEmbedding,
									limit,
									threshold,
									logger,
									peerPeers,
								);
							} catch (error) {
								logger.warn?.(
									"[memory-store] Iterative semantic search failed; using lexical results only:",
									error,
								);
							}
						}

						const candidates = filterByDateRange(
							mergeByMaxScore([
								lexicalHits.map(toIterativeRecallCandidate),
								semanticHits.map(toIterativeRecallCandidate),
							]),
							request.dateFrom,
							request.dateTo,
						);

						return { candidates };
					},
				},
			});

			if (reasoningInfo) {
				reasoningInfo.iterations = result.stats.iterations;
				reasoningInfo.evidenceCount = result.evidence.length;
				// The planner catches its own LLM errors and reports degraded
				// state via lastDegraded(); mirror the rewriter pattern so
				// callers see a single, consistent degraded marker regardless
				// of which reasoning provider they wired up.
				if (planner.lastDegraded?.()) {
					reasoningInfo.degraded = true;
				}
			}

			const evidence = result.evidence.map((candidate) => ({
				type: "memory" as const,
				id: candidate.id,
				content: candidate.content,
				similarity: candidate.similarity,
				metadata: { ...candidate.metadata, reasoning: reasoningStrategy },
			}));

			if (reasoningStrategy === "iterative") {
				return { semantic: evidence, lexical: [] };
			}
			// union: fall through to the baseline hybrid path; merge below.
			unionEvidence = evidence;
		}

		// When no embedding is configured, use default lexical search as fallback
		if (typeof deps.embedQuery !== "function") {
			warnings.push({
				source: "memory",
				code: "semantic_unavailable",
				message: "Semantic search is unavailable because no embedding provider is configured.",
			});
			warnings.push({
				source: "memory",
				code: "memory_lexical_search_fallback",
				message: "Semantic search not configured, using keyword search as fallback",
			});

			const keywords = deriveLexicalKeywords(input.query);
			const lexical = filterByDateRange(
				await runLexicalSearchForKeywords(deps, input, keywords, limit, logger, peerPeers),
				input.dateFrom,
				input.dateTo,
			);
			return { semantic: [], lexical };
		}

		let semantic: UnifiedMemorySearchResult[] = [];

		// At this point embedQuery is guaranteed to be a function because the
		// non-function case returns early above. Capture it in a local constant so
		// the narrowing is preserved inside the map() callbacks below.
		const embedQuery = deps.embedQuery;
		const activeMergeStrategy = normalizeUnifiedMemoryMergeStrategy(
			input.mergeStrategy ?? deps.reasoning?.defaultMergeStrategy ?? "rrf",
		);
		if (
			reasoningStrategy === "none" &&
			activeMergeStrategy === "rrf" &&
			input.threshold === undefined &&
			typeof deps.searchRawMessagesHybrid === "function"
		) {
			const queryEmbedding = await embedQueryVariant(embedQuery, input, input.query);
			const filters = input.botIds && input.botIds.length > 0 ? input.botIds : [undefined];
			const hybrid = (
				await Promise.all(
					filters.map((botId) =>
						deps.searchRawMessagesHybrid?.({
							userId: input.userId,
							query: input.query,
							queryEmbedding,
							limit: Math.ceil(limit / filters.length),
							botId,
						}),
					),
				)
			)
				.flatMap((items) => items ?? [])
				.filter(isRawMemorySemanticResult)
				.map(toMemoryResult);
			return { semantic: [], lexical: [], hybrid: filterByDateRange(hybrid, input.dateFrom, input.dateTo) };
		}

		// Rewrite strategy: embed multiple query variants and keep the best score
		// per memory.
		if (reasoningStrategy === "rewrite" && deps.reasoning?.queryRewriter) {
			try {
				const variants = await deps.reasoning.queryRewriter.rewrite({
					query: input.query,
					userId: input.userId,
					authToken: input.authToken,
				});
				if (reasoningInfo) {
					reasoningInfo.rewrittenQueries = variants;
					// The rewriter catches its own LLM errors and degrades to
					// `[original]` silently, so we ask it whether the last call
					// fell back instead of relying on a thrown error.
					if (deps.reasoning.queryRewriter.lastDegraded?.()) {
						reasoningInfo.degraded = true;
					}
				}

				const embeddings = await Promise.all(
					variants.map((variant) => embedQueryVariant(embedQuery, input, variant)),
				);
				const lists = await Promise.all(
					embeddings.map((embedding) =>
						runSemanticSearchForEmbedding(deps, input, embedding, limit, threshold, logger, peerPeers),
					),
				);
				semantic = mergeByMaxScore(lists);
			} catch (error) {
				logger.warn?.("[memory-store] Query rewriting failed; falling back to original query:", error);
				warnings.push({
					source: "memory",
					code: "memory_query_rewrite_failed",
					message: `Query rewriting failed: ${(error as Error).message ?? "Unknown error"}. Using original query.`,
				});
				if (reasoningInfo) reasoningInfo.degraded = true;
			}
		}

		// Default path, also used as fallback when rewrite fails before producing hits.
		if (semantic.length === 0) {
			const queryEmbedding = await embedQueryVariant(embedQuery, input, input.query);
			semantic = await runSemanticSearchForEmbedding(
				deps,
				input,
				queryEmbedding,
				limit,
				threshold,
				logger,
				peerPeers,
			);
		}

		// Optional lexical (BM25) sub-query. Runs in parallel with the semantic
		// sub-query when both are configured. Failures degrade gracefully to
		// semantic-only results; missing config is not a failure unless the
		// caller asked for RRF (then we surface a warning + fallback to
		// similarity-equivalent single-list RRF).
		let lexical: UnifiedMemorySearchResult[] = [];
		const keywords = deriveLexicalKeywords(input.query);
		if (keywords.length > 0) {
			if (typeof deps.searchRawMessagesLexical === "function") {
				try {
					const lexFilters = input.botIds && input.botIds.length > 0 ? input.botIds : [undefined];
					const searchRawMessagesLexical = deps.searchRawMessagesLexical;
					const factTypes = input.factTypes?.length ? input.factTypes : undefined;
					lexical = (
						await Promise.all(
							lexFilters.map((botId) =>
								searchRawMessagesLexical({
									userId: input.userId,
									keywords,
									limit,
									botId,
									...(peerPeers.length > 0 ? { peers: peerPeers } : {}),
									...(factTypes ? { factTypes } : {}),
								}),
							),
						)
					)
						.flat()
						.filter(isRawMemorySemanticResult)
						.map((hit) => ({
							...toMemoryResult(hit),
							metadata: { ...hit.metadata, scoring: "bm25" },
						}));
				} catch (error) {
					logger.warn?.("[memory-store] lexical memory search failed:", error);
					warnings.push({
						source: "memory",
						code: "memory_lexical_search_failed",
						message: (error as Error).message ?? "memory_lexical_search_failed",
					});
				}
			} else if (input.mergeStrategy === "rrf") {
				warnings.push({
					source: "memory",
					code: "memory_lexical_search_not_configured",
					message:
						"RRF merge requested but lexical search is not configured; falling back to semantic-only RRF.",
				});
			}
		}

		// Optional entity sub-query. Driven by `deps.entitySearch`; the
		// sub-query is silent (no warning) when the host simply hasn't
		// wired an entity search dep, except when RRF was explicitly
		// requested — then we surface a not-configured warning that
		// mirrors the lexical path.
		let entity: UnifiedMemorySearchResult[] | undefined;
		if (typeof deps.entitySearch === "function") {
			entity = filterByDateRange(
				await runEntitySearchForQuery(deps, input, limit, logger, peerPeers),
				input.dateFrom,
				input.dateTo,
			);
			if (entity.length === 0) {
				entity = undefined;
			} else if (
				normalizeUnifiedMemoryMergeStrategy(
					input.mergeStrategy ?? deps.reasoning?.defaultMergeStrategy ?? "rrf",
				) !== "rrf"
			) {
				// Entity scores are fused via RRF; under a similarity merge the
				// standalone entity hits are suppressed (see `mergeAcrossSources`),
				// so surface a hint that the caller should opt into RRF to see them.
				warnings.push({
					source: "memory",
					code: "memory_entity_requires_rrf",
					message:
						"Entity channel results are fused via RRF; with mergeStrategy:'similarity' standalone entity hits are suppressed (only the entity channel signal is kept on co-occurring hits). Request mergeStrategy:'rrf' to surface entity matches.",
				});
			}
		} else if (input.mergeStrategy === "rrf") {
			warnings.push({
				source: "memory",
				code: "memory_entity_search_not_configured",
				message:
					"RRF merge requested but entity search is not configured; falling back to semantic+lexical RRF.",
			});
		}

		if (unionEvidence) {
			// Union strategy: planner evidence first, baseline hybrid hits fill the
			// remaining budget. Dedup by hit id (both channels surface the same
			// underlying messages), cap at `limit` so the context budget matches
			// the plain top-k run. Planner hits get a tiny synthetic score boost
			// above the best baseline hit so any downstream similarity sort keeps
			// them in front instead of dropping low-scored evidence.
			const plannerHits = unionEvidence;
			const base = mergeByMaxScore([
				filterByDateRange(semantic, input.dateFrom, input.dateTo),
				filterByDateRange(lexical, input.dateFrom, input.dateTo),
			]);
			const maxBase = base.length > 0 ? Math.max(...base.map((h) => h.similarity)) : 0;
			const seen = new Set<string>();
			const merged: UnifiedMemorySearchResult[] = [];
			plannerHits.forEach((hit, i) => {
				if (seen.has(hit.id)) {
					return;
				}
				seen.add(hit.id);
				merged.push({
					...hit,
					similarity: maxBase + (plannerHits.length - i) * 1e-6,
				});
			});
			for (const hit of base) {
				if (merged.length >= limit) {
					break;
				}
				if (seen.has(hit.id)) {
					continue;
				}
				seen.add(hit.id);
				merged.push(hit);
			}
			return { semantic: merged.slice(0, limit), lexical: [] };
		}

		const out: MemorySubQueries = {
			semantic: filterByDateRange(semantic, input.dateFrom, input.dateTo),
			lexical: filterByDateRange(lexical, input.dateFrom, input.dateTo),
		};
		if (entity && entity.length > 0) {
			out.entity = entity;
		}
		return out;
	}

	async function searchUnifiedMemory(input: UnifiedMemorySearchInput): Promise<UnifiedMemorySearchOutput> {
		const query = input.query.trim();
		const sources = normalizeUnifiedMemorySearchSources(input.sources);
		const limit = clampUnifiedMemorySearchLimit(input.limit);
		// RRF is the new default merge strategy (see the `@melandlabs/memory-store`
		// changeset). A caller can override per-request via `input.mergeStrategy`,
		// or fall back to the legacy similarity order via
		// `deps.reasoning.defaultMergeStrategy = "similarity"`.
		const mergeStrategy = normalizeUnifiedMemoryMergeStrategy(
			input.mergeStrategy ?? deps.reasoning?.defaultMergeStrategy ?? "rrf",
		);
		const candidateLimit = Math.min(50, Math.max(limit, limit * 4));
		const threshold = clampUnifiedMemorySearchThreshold(input.threshold);
		const memoryThreshold =
			input.threshold === undefined && mergeStrategy === "rrf" ? Number.NEGATIVE_INFINITY : threshold;
		const reasoningStrategy = resolveReasoningStrategy(input);
		const warnings: UnifiedMemorySearchWarning[] = [];

		// Resolve the optional `peerFilter` against the host's `peerScopeCheck`.
		// `resolveScopePeer` guarantees the resulting peers are a strict
		// narrowing of `userId` and never broaden the search scope.
		const peerScope =
			input.peerFilter && input.peerFilter.length > 0
				? await resolveScopePeer({
						userId: input.userId,
						peerFilter: input.peerFilter,
						scopeCheck: deps.peerScopeCheck,
					})
				: { peers: [] as Peer[], warnings: [] as UnifiedMemorySearchWarning[] };
		warnings.push(...peerScope.warnings);
		const peerPeers = peerScope.peers;

		if (!query) {
			return {
				query,
				sources,
				results: [],
				count: 0,
				warnings,
			};
		}

		let memorySubs: MemorySubQueries | undefined;
		let retrievalStatus:
			| Awaited<ReturnType<NonNullable<UnifiedSearchDeps["getRawMessageRetrievalStatus"]>>>
			| undefined;
		const reasoningInfo: UnifiedMemorySearchOutput["reasoning"] = { strategy: reasoningStrategy };
		if (input.dateFrom || input.dateTo) {
			reasoningInfo.dateRange = { from: input.dateFrom, to: input.dateTo };
		}

		if (sources.includes("memory")) {
			// Only skip when storage is truly unavailable AND no provider
			// is wired. The legacy check on `isRawMessageStorageAvailable`
			// alone dropped hits when callers configured a custom
			// `searchRawMessagesAnn` / `searchRawMessagesLexical` (the
			// synthesis path needs those raw hits regardless of whether
			// the bundled SQLite singleton is up).
			const hasRawProviders =
				typeof deps.searchRawMessagesAnn === "function" ||
				typeof deps.searchRawMessagesHybrid === "function" ||
				typeof deps.searchRawMessagesLexical === "function";
			if (isRawMessageStorageAvailable() || hasRawProviders) {
				try {
					memorySubs = await runMemorySource(
						input,
						candidateLimit,
						memoryThreshold,
						warnings,
						reasoningStrategy,
						reasoningInfo,
						peerPeers,
					);
					memorySubs = {
						semantic: dedupeChannelByParent(memorySubs.semantic),
						lexical: dedupeChannelByParent(memorySubs.lexical),
						...(memorySubs.hybrid ? { hybrid: dedupeChannelByParent(memorySubs.hybrid) } : {}),
						...(memorySubs.entity ? { entity: dedupeChannelByParent(memorySubs.entity) } : {}),
					};
					if (deps.getRawMessageRetrievalStatus) {
						retrievalStatus = await deps.getRawMessageRetrievalStatus();
					}
					if (
						memorySubs.semantic.length === 0 &&
						(memorySubs.hybrid?.length ?? 0) === 0 &&
						typeof deps.embedQuery === "function"
					) {
						let code = "semantic_candidates_empty";
						let message = "Semantic search was available but returned no candidates.";
						if (retrievalStatus?.embeddedChildCount === 0) {
							code = "semantic_unavailable";
							message = "No embedded RawMessage children are available for semantic search.";
						} else if (
							retrievalStatus?.embeddingDimensions &&
							retrievalStatus.indexedDimensions.length > 0 &&
							!retrievalStatus.indexedDimensions.includes(retrievalStatus.embeddingDimensions)
						) {
							code = "semantic_dimension_mismatch";
							message = `Query embedding dimension ${retrievalStatus.embeddingDimensions} does not match indexed child dimensions ${retrievalStatus.indexedDimensions.join(", ")}.`;
						}
						warnings.push({ source: "memory", code, message });
					}
				} catch (error) {
					logger.warn?.("[memory-store] memory source failed:", error);
					warnings.push({
						source: "memory",
						code: "memory_search_failed",
						message: `Memory search failed: ${(error as Error).message ?? "Unknown error"}. Using keyword search fallback.`,
					});
				}
			} else {
				warnings.push({
					source: "memory",
					code: "raw_message_storage_unavailable",
					message: "Raw memory storage is not available in this environment.",
				});
			}
		}

		const insightHits: UnifiedMemorySearchResult[] = [];
		if (sources.includes("insights") && typeof deps.searchInsights === "function") {
			try {
				const hits = await deps.searchInsights({
					userId: input.userId,
					query: input.query,
					limit: candidateLimit,
					threshold,
					botIds: input.botIds,
					includeArchived: input.includeArchivedInsights,
					authToken: input.authToken,
					...(peerPeers.length > 0 ? { peers: peerPeers } : {}),
				});
				for (const hit of hits) {
					insightHits.push({
						type: "insight",
						id: hit.id,
						content: hit.content,
						similarity: hit.similarity,
						metadata: hit.metadata,
					});
				}
			} catch (error) {
				logger.warn?.("[memory-store] insights source failed:", error);
				warnings.push({
					source: "insights",
					code: "insights_search_failed",
					message: (error as Error).message ?? "insights_search_failed",
				});
			}
		} else if (sources.includes("insights")) {
			// Insights is an optional feature - skip silently instead of warning
			// Users need to set up insights extraction first
		}

		const knowledgeHits: UnifiedMemorySearchResult[] = [];
		if (sources.includes("knowledge") && typeof deps.searchKnowledge === "function") {
			try {
				const hits = await deps.searchKnowledge({
					userId: input.userId,
					query: input.query,
					options: {
						limit: candidateLimit,
						threshold,
						documentIds: input.documentIds,
					},
					authToken: input.authToken,
					...(peerPeers.length > 0 ? { peers: peerPeers } : {}),
				});
				for (const hit of hits) {
					knowledgeHits.push(toKnowledgeResult(hit));
				}
			} catch (error) {
				logger.warn?.("[memory-store] knowledge source failed:", error);
				warnings.push({
					source: "knowledge",
					code: "knowledge_search_failed",
					message: (error as Error).message ?? "knowledge_search_failed",
				});
			}
		} else if (sources.includes("knowledge")) {
			// Knowledge is an optional feature - skip silently instead of warning
			// Users need to upload and index documents first
		}

		const merged = mergeAcrossSources({
			memorySubs,
			insightHits,
			knowledgeHits,
			limit: candidateLimit,
			strategy: mergeStrategy,
		});

		// The optional host reranker sees the complete overfetched window. Only
		// after reranking do we truncate to the public Top-K.
		const rerankerStartedAt = Date.now();
		const reranked = await applyReranker(deps.reranker, input.query, merged);
		const rerankerLatencyMs = deps.reranker ? Date.now() - rerankerStartedAt : 0;
		const rerankerOrderChanged =
			Boolean(deps.reranker) &&
			merged.some((hit, index) => hit.id !== reranked[index]?.id);
		const ranked = reranked.slice(0, limit);

		const output: UnifiedMemorySearchOutput = {
			query: input.query,
			sources,
			results: ranked,
			count: ranked.length,
			warnings,
		};
		if (input.includeRetrievalDiagnostics) {
			output.retrievalDiagnostics = {
				mergeStrategy,
				candidateLimit,
				backend: retrievalStatus?.backend,
				semanticDegradedReason:
					retrievalStatus?.semanticDegradedReason ??
					warnings.find((warning) => warning.code.startsWith("semantic_"))?.code,
				candidateCounts: {
					semantic: memorySubs?.semantic.length ?? 0,
					lexical: memorySubs?.lexical.length ?? 0,
					hybrid: memorySubs?.hybrid?.length ?? 0,
					entity: memorySubs?.entity?.length ?? 0,
					fused: merged.length,
					final: ranked.length,
				},
				channels: {
					semantic: memorySubs?.semantic ?? [],
					lexical: memorySubs?.lexical ?? [],
					...(memorySubs?.hybrid ? { hybrid: memorySubs.hybrid } : {}),
					...(memorySubs?.entity ? { entity: memorySubs.entity } : {}),
				},
				fusedBeforeRerank: merged,
				reranker: {
					enabled: Boolean(deps.reranker),
					provider: deps.rerankerInfo?.provider,
					model: deps.rerankerInfo?.model,
					inputCount: merged.length,
					outputCount: reranked.length,
					latencyMs: rerankerLatencyMs,
					orderChanged: rerankerOrderChanged,
				},
				final: ranked,
			};
		}
		if (reasoningInfo && (reasoningInfo.strategy !== "none" || reasoningInfo.dateRange !== undefined)) {
			output.reasoning = reasoningInfo;
		}
		return output;
	}

	/**
	 * @deprecated Use `search({ ...input, sources: ["memory"] })` and
	 * read `.results` instead. Thin shim around `searchUnifiedMemory`.
	 */
	async function searchRawMemorySemantically(
		input: UnifiedMemorySearchInput,
	): Promise<UnifiedMemorySearchResult[]> {
		return (await searchUnifiedMemory({ ...input, sources: ["memory"] })).results;
	}

	// ─── New unified `search()` entry point ────────────────────────────────────
	//
	// Layered design: the cross-source read pipeline (memory + insights +
	// knowledge + RRF + reasoning strategies + date filtering + lexical
	// fallback) is delegated to `searchUnifiedMemory` so the two entry
	// points stay in lockstep. The summary tier (used by `synthesize`) is
	// bolted on via `gatherSummaries` and merged with RRF so all four
	// tiers surface in the synthesis prompt. Read-only callers that don't
	// ask for synthesis skip the summary gather entirely.

	async function search(input: SearchInput): Promise<SearchOutput> {
		const query = input.query.trim();
		const wantsSynthesis =
			typeof input.synthesize === "boolean"
				? input.synthesize
				: typeof input.synthesize === "object" && input.synthesize !== null;
		const synthesisSchema =
			typeof input.synthesize === "object" && input.synthesize !== null
				? (input.synthesize.responseSchema ?? input.responseSchema)
				: input.responseSchema;

		const peerScope = await resolveSearchScopePeers({
			deps,
			userId: input.userId,
			peerFilter: input.peerFilter,
		});

		// Empty query short-circuit — we can't gather evidence, but the
		// synthesis path still wants to know that the prompt was empty.
		if (!query) {
			const empty: SearchOutput = {
				query,
				sources: input.sources ? [...input.sources] : [],
				results: [],
				evidence: [],
				count: 0,
				warnings: peerScope.warnings,
				answer: "",
			};
			return empty;
		}

		// Decide which tiers to gather. Explicit `input.tiers` wins; when
		// absent, synthesis defaults to all four tiers and read-only
		// defaults to the three read sources (no summary).
		const tiers: ReadonlyArray<SearchTier> = input.tiers
			? [...input.tiers]
			: wantsSynthesis
				? (["summary", "raw", "insight", "knowledge"] as const)
				: (["raw", "insight", "knowledge"] as const);
		const wantsSummaryTier = tiers.includes("summary");
		const wantsRawTier = tiers.includes("raw");
		const wantsInsightTier = tiers.includes("insight");
		const wantsKnowledgeTier = tiers.includes("knowledge");

		const warnings: UnifiedMemorySearchWarning[] = [...peerScope.warnings];
		const limit = clampUnifiedMemorySearchLimit(input.limit);
		const threshold = clampUnifiedMemorySearchThreshold(input.threshold);

		// Read pipeline — handles RRF merge, reasoning strategies,
		// date filtering, lexical fallback, and the
		// `memory_lexical_search_not_configured` warning. Only run when
		// the caller's tier list actually needs at least one read source.
		let unifiedHits: UnifiedMemorySearchResult[] = [];
		let sources: UnifiedMemorySearchSource[] = input.sources ? [...input.sources] : [];
		let unifiedReasoning: UnifiedMemoryReasoningInfo | undefined;
		let retrievalDiagnostics: SearchOutput["retrievalDiagnostics"];
		if (wantsRawTier || wantsInsightTier || wantsKnowledgeTier) {
			const inferredSources: UnifiedMemorySearchSource[] =
				sources.length > 0
					? sources
					: [
							...(wantsRawTier ? (["memory"] as const) : []),
							...(wantsInsightTier ? (["insights"] as const) : []),
							...(wantsKnowledgeTier ? (["knowledge"] as const) : []),
						];
			const unified = await searchUnifiedMemory({
				...searchInputToUnified(input),
				sources: inferredSources.length > 0 ? inferredSources : undefined,
			});
			unifiedHits = unified.results;
			sources = unified.sources;
			unifiedReasoning = unified.reasoning;
			retrievalDiagnostics = unified.retrievalDiagnostics;
			warnings.push(...unified.warnings);
		}

		// Summary tier — only collected when explicitly requested (or when
		// synthesis defaults include it).
		let summaryHits: UnifiedMemorySearchResult[] = [];
		if (wantsSummaryTier && typeof deps.searchSummaries === "function") {
			const summaryBucket = await gatherSummaries(
				deps,
				{ userId: input.userId, query: input.query, authToken: input.authToken },
				limit,
				threshold,
				logger,
				peerScope.peers,
			);
			warnings.push(...summaryBucket.warnings);
			summaryHits = summaryBucket.hits;
		}

		// Merge the per-tier buckets. With a single tier we just take the
		// hits directly; with two or more we fuse with RRF.
		const tierLists: UnifiedMemoryRankedList[] = [];
		if (unifiedHits.length > 0) {
			tierLists.push({ name: "memory", hits: unifiedHits });
		}
		if (summaryHits.length > 0) {
			tierLists.push({ name: "summary", hits: summaryHits });
		}
		let hits: UnifiedMemorySearchResult[];
		if (tierLists.length === 0) {
			hits = [];
		} else if (tierLists.length === 1) {
			hits = tierLists[0].hits.slice(0, limit);
		} else {
			hits = mergeUnifiedMemorySearchResultsRrf(tierLists, limit);
		}

		const evidence: SearchEvidence[] = hits.map((hit) => ({
			id: hit.id,
			source: mapHitToEvidenceSource(hit),
			snippet: hit.content,
			score: hit.similarity,
			timestamp: getCandidateTimestamp(hit.metadata),
		}));
		const base: SearchOutput = {
			query,
			sources,
			results: hits,
			evidence,
			count: hits.length,
			warnings,
		};
		if (unifiedReasoning) {
			base.reasoning = unifiedReasoning;
		}
		if (retrievalDiagnostics) {
			base.retrievalDiagnostics = retrievalDiagnostics;
		}

		if (!wantsSynthesis) {
			return base;
		}

		const { answer, warnings: synthWarnings } = await synthesizeAnswer({
			query,
			evidence,
			responseSchema: synthesisSchema,
			deps,
			logger,
		});
		base.answer = answer;
		base.warnings = [...base.warnings, ...synthWarnings];
		return base;
	}

	// ─── Deprecated shims ─────────────────────────────────────────────────────
	//
	// Thin forwarders so the public `UnifiedSearch` surface still exposes
	// the legacy entry points. Both delegate to `search()`.

	return {
		search,
		searchUnifiedMemory,
		searchRawMemorySemantically,
		consolidate: (input: ApplyConsolidateInput) => applyReflectedPlan(deps, {}, input, logger),
	};
}

/**
 * Combine results across sources. Default behaviour: flatten into a single
 * list and let `mergeUnifiedMemorySearchResults` sort by similarity. RRF
 * strategy: feed one `rankedList` per channel so each contributes `1/(k+rank)`
 * to the fused score.
 *
 * After the merge (RRF or similarity), every emitted hit has its
 * `signals` field populated by `materializeSignals` so callers can
 * read per-channel scores without re-deriving them from metadata.
 */
function mergeAcrossSources(input: {
	memorySubs?: MemorySubQueries;
	insightHits: UnifiedMemorySearchResult[];
	knowledgeHits: UnifiedMemorySearchResult[];
	limit: number;
	strategy: UnifiedMemoryMergeStrategy;
}): UnifiedMemorySearchResult[] {
	const memorySubs = input.memorySubs ?? { semantic: [], lexical: [] };
	const lists = buildChannelLists(memorySubs, input.insightHits, input.knowledgeHits);

	if (input.strategy !== "rrf") {
		// Entity hits are fused ONLY via RRF (rank-based), because the
		// host-defined `entity` score lives on a different scale than
		// semantic cosine similarity and lexical BM25. Mixing it into the
		// global similarity sort would (a) rank cross-scale scores
		// meaninglessly and (b) let an entity hit shadow a message's own
		// real content with just its label. So in the similarity path we
		// drop standalone entity hits; `buildChannelLists` still includes
		// the entity list so `materializeSignals` can mark the `entity`
		// channel on co-occurring (semantic/lexical) hits. A caller that
		// wants entity matches surfaced should request `mergeStrategy:'rrf'`.
		// Dedupe by `(type, id)` so a hit surfaced by both semantic and
		// lexical channels does not appear twice — keep the higher-similarity instance.
		const seen = new Map<string, UnifiedMemorySearchResult>();
		for (const hit of [
			...memorySubs.semantic,
			...memorySubs.lexical,
			...(memorySubs.hybrid ?? []),
			...input.insightHits,
			...input.knowledgeHits,
		]) {
			const key = `${hit.type}::${hit.id}`;
			const existing = seen.get(key);
			if (!existing || hit.similarity > existing.similarity) {
				seen.set(key, hit);
			}
		}
		const merged = mergeUnifiedMemorySearchResults(Array.from(seen.values()), input.limit);
		return attachSignals(merged, lists);
	}

	const all: UnifiedMemorySearchResult[] = [
		...memorySubs.semantic,
		...memorySubs.lexical,
		...(memorySubs.hybrid ?? []),
		...(memorySubs.entity ?? []),
		...input.insightHits,
		...input.knowledgeHits,
	];

	const merged: UnifiedMemorySearchResult[] =
		lists.length <= 1
			? mergeUnifiedMemorySearchResults(all, input.limit)
			: mergeUnifiedMemorySearchResultsRrf(lists, input.limit);
	return attachSignals(merged, lists);
}

function buildChannelLists(
	memorySubs: MemorySubQueries,
	insightHits: UnifiedMemorySearchResult[],
	knowledgeHits: UnifiedMemorySearchResult[],
): UnifiedMemoryRankedList[] {
	const lists: UnifiedMemoryRankedList[] = [];
	if (memorySubs.semantic.length > 0) lists.push({ name: "memory-semantic", hits: memorySubs.semantic });
	if (memorySubs.lexical.length > 0) lists.push({ name: "memory-bm25", hits: memorySubs.lexical });
	if (memorySubs.hybrid && memorySubs.hybrid.length > 0) {
		lists.push({ name: "memory-hybrid", hits: memorySubs.hybrid });
	}
	if (memorySubs.entity && memorySubs.entity.length > 0) {
		lists.push({ name: "memory-entity", hits: memorySubs.entity });
	}
	if (insightHits.length > 0) lists.push({ name: "insights", hits: insightHits });
	if (knowledgeHits.length > 0) lists.push({ name: "knowledge", hits: knowledgeHits });
	return lists;
}

/**
 * Attach `signals` to every hit using the per-channel ranked lists
 * that fed the merge. Pure — no I/O — and stable across calls because
 * it only inspects the lists in declaration order.
 */
function attachSignals(
	hits: UnifiedMemorySearchResult[],
	lists: UnifiedMemoryRankedList[],
): UnifiedMemorySearchResult[] {
	if (hits.length === 0 || lists.length === 0) {
		return hits;
	}
	return hits.map((hit) => {
		const signals = materializeSignals(lists, hit);
		if (!signals) {
			return hit;
		}
		return { ...hit, signals };
	});
}
