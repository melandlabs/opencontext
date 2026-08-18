/**
 * Unified semantic search facade.
 *
 * Cross-source search over raw messages (always), insights, and
 * uploaded knowledge documents. The host wires up the cross-domain
 * dependencies via `UnifiedSearchDeps` so this module stays
 * framework-agnostic.
 */

import type { Peer } from "@melandlabs/contracts/peer";
import type { UnifiedSearchDeps } from "../config";
import { isRawMessageChromaEnabled, searchRawMessagesWithChroma } from "../storage/chroma-memory-index";
import { isRawMessageStorageAvailable } from "../storage/raw-message-store";
import { type ApplyReflectInput, type ApplyReflectOutput, applyReflectedPlan } from "./apply-reflect";
import type {
	IterativeRecallCandidate,
	IterativeRecallSearchRequest,
	IterativeRecallSearchResult,
} from "./iterative-recall";
import { type ReflectInput, type ReflectOutput, reflect } from "./reflect";
import { applyReranker } from "./reranker";
import {
	type UnifiedMemoryMergeStrategy,
	type UnifiedMemoryRankedList,
	type UnifiedMemoryReasoningStrategy,
	type UnifiedMemorySearchInput,
	type UnifiedMemorySearchOutput,
	type UnifiedMemorySearchResult,
	type UnifiedMemorySearchWarning,
	clampUnifiedMemorySearchLimit,
	clampUnifiedMemorySearchThreshold,
	isRawMemorySemanticResult,
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
	UnifiedMemoryMergeStrategy,
	UnifiedMemoryRankedList,
	UnifiedMemoryReasoningStrategy,
	UnifiedMemorySearchInput,
	UnifiedMemorySearchOutput,
	UnifiedMemorySearchResult,
	UnifiedMemorySearchSource,
	UnifiedMemorySearchWarning,
} from "./utilities";

export {
	clampUnifiedMemorySearchLimit,
	clampUnifiedMemorySearchThreshold,
	isRawMemorySemanticResult,
	mergeUnifiedMemorySearchResults,
	mergeUnifiedMemorySearchResultsRrf,
	normalizeUnifiedMemoryMergeStrategy,
	normalizeUnifiedMemoryReasoningStrategy,
	normalizeUnifiedMemorySearchSources,
	toKnowledgeResult,
	toMemoryResult,
} from "./utilities";

export interface UnifiedSearch {
	searchUnifiedMemory(input: UnifiedMemorySearchInput): Promise<UnifiedMemorySearchOutput>;
	searchRawMemorySemantically(input: UnifiedMemorySearchInput): Promise<UnifiedMemorySearchResult[]>;
	/**
	 * Single-turn LLM synthesis over the unified evidence pipeline.
	 * See `./reflect.ts` for the contract and degradation rules.
	 */
	reflect(input: ReflectInput): Promise<ReflectOutput>;
	/**
	 * Agentic write-back: runs the same evidence pipeline as `reflect`,
	 * then builds a memory-consolidation plan, optionally asks the LLM
	 * to veto unsafe entries, and persists via the attached graph store
	 * (when present) + soft-deprecates superseded records via the storage
	 * adapter. See `./apply-reflect.ts` for the contract and degradation
	 * rules.
	 */
	reflectWithPlan(input: ApplyReflectInput): Promise<ApplyReflectOutput>;
}

function deriveLexicalKeywords(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length >= 2)
		.slice(0, 16);
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

	if (isRawMessageChromaEnabled()) {
		try {
			semantic = (
				await Promise.all(
					filters.map((filter) => {
						const botId = "botId" in filter ? filter.botId : undefined;
						return searchRawMessagesWithChroma({
							userId: input.userId,
							queryEmbedding,
							limit,
							threshold,
							botId,
						});
					}),
				)
			)
				.flat()
				.map(toMemoryResult);
			logger.log?.("[memory-store] Raw message semantic search completed", {
				backend: "chroma",
				dimensions: queryEmbedding.length,
				count: semantic.length,
			});
		} catch (error) {
			logger.warn?.(
				"[memory-store] Chroma raw message search failed; falling back to database search:",
				error,
			);
		}
	} else if (typeof deps.searchRawMessagesAnn === "function") {
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

	if (semantic.length === 0) {
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
 */
interface MemorySubQueries {
	semantic: UnifiedMemorySearchResult[];
	lexical: UnifiedMemorySearchResult[];
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

	async function searchUnifiedMemory(input: UnifiedMemorySearchInput): Promise<UnifiedMemorySearchOutput> {
		const query = input.query.trim();
		const sources = normalizeUnifiedMemorySearchSources(input.sources);
		const limit = clampUnifiedMemorySearchLimit(input.limit);
		const threshold = clampUnifiedMemorySearchThreshold(input.threshold);
		// RRF is the new default merge strategy (see the `@melandlabs/memory-store`
		// changeset). A caller can override per-request via `input.mergeStrategy`,
		// or fall back to the legacy similarity order via
		// `deps.reasoning.defaultMergeStrategy = "similarity"`.
		const mergeStrategy = normalizeUnifiedMemoryMergeStrategy(
			input.mergeStrategy ?? deps.reasoning?.defaultMergeStrategy ?? "rrf",
		);
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
		const reasoningInfo: UnifiedMemorySearchOutput["reasoning"] = { strategy: reasoningStrategy };
		if (input.dateFrom || input.dateTo) {
			reasoningInfo.dateRange = { from: input.dateFrom, to: input.dateTo };
		}

		if (sources.includes("memory")) {
			if (isRawMessageStorageAvailable()) {
				try {
					memorySubs = await runMemorySource(
						input,
						limit,
						threshold,
						warnings,
						reasoningStrategy,
						reasoningInfo,
						peerPeers,
					);
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
					limit,
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
						limit,
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
			limit,
			strategy: mergeStrategy,
		});

		// Optional host reranker, applied after the cross-source merge. The
		// merged list is already capped at `limit`, so the reranker reorders
		// (and may re-score) within that window rather than expanding it.
		const ranked = await applyReranker(deps.reranker, input.query, merged);

		const output: UnifiedMemorySearchOutput = {
			query: input.query,
			sources,
			results: ranked,
			count: ranked.length,
			warnings,
		};
		if (reasoningInfo && (reasoningInfo.strategy !== "none" || reasoningInfo.dateRange !== undefined)) {
			output.reasoning = reasoningInfo;
		}
		return output;
	}

	async function runMemorySource(
		input: UnifiedMemorySearchInput,
		limit: number,
		threshold: number,
		warnings: UnifiedMemorySearchWarning[],
		reasoningStrategy: UnifiedMemoryReasoningStrategy = "none",
		reasoningInfo?: UnifiedMemorySearchOutput["reasoning"],
		peerPeers: ReadonlyArray<Peer> = [],
	): Promise<MemorySubQueries> {
		if (reasoningStrategy === "iterative" && !deps.reasoning?.iterativePlanner) {
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
		// exact matching and dense retrieval.
		if (reasoningStrategy === "iterative" && deps.reasoning?.iterativePlanner) {
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

			const semantic = result.evidence.map((candidate) => ({
				type: "memory" as const,
				id: candidate.id,
				content: candidate.content,
				similarity: candidate.similarity,
				metadata: { ...candidate.metadata, reasoning: "iterative" },
			}));

			return { semantic, lexical: [] };
		}

		// When no embedding is configured, use default lexical search as fallback
		if (typeof deps.embedQuery !== "function") {
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

		return {
			semantic: filterByDateRange(semantic, input.dateFrom, input.dateTo),
			lexical: filterByDateRange(lexical, input.dateFrom, input.dateTo),
		};
	}

	async function searchRawMemorySemantically(
		input: UnifiedMemorySearchInput,
	): Promise<UnifiedMemorySearchResult[]> {
		const limit = clampUnifiedMemorySearchLimit(input.limit);
		const threshold = clampUnifiedMemorySearchThreshold(input.threshold);
		const reasoningStrategy = resolveReasoningStrategy(input);
		// Same default resolution as `searchUnifiedMemory`: per-request
		// override, then `deps.reasoning?.defaultMergeStrategy`, then "rrf".
		const mergeStrategy = normalizeUnifiedMemoryMergeStrategy(
			input.mergeStrategy ?? deps.reasoning?.defaultMergeStrategy ?? "rrf",
		);
		const sub = await runMemorySource(input, limit, threshold, [], reasoningStrategy);
		return mergeAcrossSources({
			memorySubs: sub,
			insightHits: [],
			knowledgeHits: [],
			limit,
			strategy: mergeStrategy,
		});
	}

	return {
		searchUnifiedMemory,
		searchRawMemorySemantically,
		reflect: (input: ReflectInput) => reflect(deps, input, logger),
		reflectWithPlan: (input: ApplyReflectInput) => applyReflectedPlan(deps, {}, input, logger),
	};
}

/**
 * Combine results across sources. Default behaviour: flatten into a single
 * list and let `mergeUnifiedMemorySearchResults` sort by similarity. RRF
 * strategy: feed one `rankedList` per channel so each contributes `1/(k+rank)`
 * to the fused score.
 */
function mergeAcrossSources(input: {
	memorySubs?: MemorySubQueries;
	insightHits: UnifiedMemorySearchResult[];
	knowledgeHits: UnifiedMemorySearchResult[];
	limit: number;
	strategy: UnifiedMemoryMergeStrategy;
}): UnifiedMemorySearchResult[] {
	const memorySubs = input.memorySubs ?? { semantic: [], lexical: [] };
	const all: UnifiedMemorySearchResult[] = [
		...memorySubs.semantic,
		...memorySubs.lexical,
		...input.insightHits,
		...input.knowledgeHits,
	];

	if (input.strategy !== "rrf") {
		return mergeUnifiedMemorySearchResults(all, input.limit);
	}

	const lists: UnifiedMemoryRankedList[] = [];
	if (memorySubs.semantic.length > 0) {
		lists.push({ name: "memory-semantic", hits: memorySubs.semantic });
	}
	if (memorySubs.lexical.length > 0) {
		lists.push({ name: "memory-bm25", hits: memorySubs.lexical });
	}
	if (input.insightHits.length > 0) {
		lists.push({ name: "insights", hits: input.insightHits });
	}
	if (input.knowledgeHits.length > 0) {
		lists.push({ name: "knowledge", hits: input.knowledgeHits });
	}

	if (lists.length <= 1) {
		// RRF degenerates to a single list — equivalent to the default sort.
		return mergeUnifiedMemorySearchResults(all, input.limit);
	}
	return mergeUnifiedMemorySearchResultsRrf(lists, input.limit);
}
