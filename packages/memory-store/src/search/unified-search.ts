/**
 * Unified semantic search facade.
 *
 * Cross-source search over raw messages (always), insights, and
 * uploaded knowledge documents. The host wires up the cross-domain
 * dependencies via `UnifiedSearchDeps` so this module stays
 * framework-agnostic.
 */

import type { UnifiedSearchDeps } from "../config";
import { isRawMessageChromaEnabled, searchRawMessagesWithChroma } from "../storage/chroma-memory-index";
import { isRawMessageStorageAvailable } from "../storage/raw-message-store";
import {
	type UnifiedMemoryMergeStrategy,
	type UnifiedMemoryRankedList,
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
	normalizeUnifiedMemorySearchSources,
	toKnowledgeResult,
	toMemoryResult,
} from "./utilities";

export type {
	UnifiedMemoryMergeStrategy,
	UnifiedMemoryRankedList,
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
	normalizeUnifiedMemorySearchSources,
	toKnowledgeResult,
	toMemoryResult,
} from "./utilities";

export interface UnifiedSearch {
	searchUnifiedMemory(input: UnifiedMemorySearchInput): Promise<UnifiedMemorySearchOutput>;
	searchRawMemorySemantically(input: UnifiedMemorySearchInput): Promise<UnifiedMemorySearchResult[]>;
}

function deriveLexicalKeywords(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length >= 2)
		.slice(0, 16);
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
	const logger = (deps as { logger?: Console }).logger ?? console;

	async function searchUnifiedMemory(input: UnifiedMemorySearchInput): Promise<UnifiedMemorySearchOutput> {
		const query = input.query.trim();
		const sources = normalizeUnifiedMemorySearchSources(input.sources);
		const limit = clampUnifiedMemorySearchLimit(input.limit);
		const threshold = clampUnifiedMemorySearchThreshold(input.threshold);
		const mergeStrategy = normalizeUnifiedMemoryMergeStrategy(input.mergeStrategy);
		const warnings: UnifiedMemorySearchWarning[] = [];

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
		if (sources.includes("memory")) {
			if (isRawMessageStorageAvailable()) {
				try {
					memorySubs = await runMemorySource(input, limit, threshold, warnings);
				} catch (error) {
					logger.warn?.("[memory-store] memory source failed:", error);
					warnings.push({
						source: "memory",
						code: "memory_search_failed",
						message: (error as Error).message ?? "memory_search_failed",
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
			warnings.push({
				source: "insights",
				code: "insights_search_not_configured",
				message: "Insights search is not configured for this host.",
			});
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
			warnings.push({
				source: "knowledge",
				code: "knowledge_search_not_configured",
				message: "Knowledge search is not configured for this host.",
			});
		}

		const merged = mergeAcrossSources({
			memorySubs,
			insightHits,
			knowledgeHits,
			limit,
			strategy: mergeStrategy,
		});

		return {
			query: input.query,
			sources,
			results: merged,
			count: merged.length,
			warnings,
		};
	}

	async function runMemorySource(
		input: UnifiedMemorySearchInput,
		limit: number,
		threshold: number,
		warnings: UnifiedMemorySearchWarning[],
	): Promise<MemorySubQueries> {
		if (typeof deps.embedQuery !== "function") {
			throw new Error("embedQuery is not configured");
		}

		const queryEmbedding = await deps.embedQuery({
			userId: input.userId,
			query: input.query,
			authToken: input.authToken,
		});

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
				// fall through to ANN below
			}
		} else if (typeof deps.searchRawMessagesAnn === "function") {
			semantic = (
				await Promise.all(
					filters.map((filter) =>
						deps.searchRawMessagesAnn!({
							userId: input.userId,
							queryEmbedding,
							limit,
							threshold,
							botId: "botId" in filter ? filter.botId : undefined,
						}),
					),
				)
			)
				.flat()
				.filter(isRawMemorySemanticResult)
				.map(toMemoryResult);
		}

		// Optional lexical (BM25) sub-query. Runs in parallel with the semantic
		// sub-query when both are configured. Failures degrade gracefully to
		// semantic-only results; missing config is not a failure unless the
		// caller asked for RRF (then we surface a warning + fallback to
		// similarity-equivalent single-list RRF).
		let lexical: UnifiedMemorySearchResult[] = [];
		if (typeof deps.searchRawMessagesLexical === "function") {
			const keywords = deriveLexicalKeywords(input.query);
			if (keywords.length > 0) {
				try {
					const lexFilters = input.botIds && input.botIds.length > 0 ? input.botIds : [undefined];
					lexical = (
						await Promise.all(
							lexFilters.map((botId) =>
								deps.searchRawMessagesLexical!({
									userId: input.userId,
									keywords,
									limit,
									botId,
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
			}
		} else if (input.mergeStrategy === "rrf") {
			warnings.push({
				source: "memory",
				code: "memory_lexical_search_not_configured",
				message:
					"RRF merge requested but lexical search is not configured; falling back to semantic-only RRF.",
			});
		}

		return { semantic, lexical };
	}

	async function searchRawMemorySemantically(
		input: UnifiedMemorySearchInput,
	): Promise<UnifiedMemorySearchResult[]> {
		const limit = clampUnifiedMemorySearchLimit(input.limit);
		const threshold = clampUnifiedMemorySearchThreshold(input.threshold);
		const sub = await runMemorySource(input, limit, threshold, []);
		return mergeAcrossSources({
			memorySubs: sub,
			insightHits: [],
			knowledgeHits: [],
			limit,
			strategy: normalizeUnifiedMemoryMergeStrategy(input.mergeStrategy),
		});
	}

	return { searchUnifiedMemory, searchRawMemorySemantically };
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
