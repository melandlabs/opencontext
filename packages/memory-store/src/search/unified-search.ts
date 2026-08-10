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
	type UnifiedMemorySearchInput,
	type UnifiedMemorySearchOutput,
	type UnifiedMemorySearchResult,
	type UnifiedMemorySearchWarning,
	clampUnifiedMemorySearchLimit,
	clampUnifiedMemorySearchThreshold,
	isRawMemorySemanticResult,
	mergeUnifiedMemorySearchResults,
	normalizeUnifiedMemorySearchSources,
	toKnowledgeResult,
	toMemoryResult,
} from "./utilities";

export type {
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
	normalizeUnifiedMemorySearchSources,
	toKnowledgeResult,
	toMemoryResult,
} from "./utilities";

export interface UnifiedSearch {
	searchUnifiedMemory(input: UnifiedMemorySearchInput): Promise<UnifiedMemorySearchOutput>;
	searchRawMemorySemantically(input: UnifiedMemorySearchInput): Promise<UnifiedMemorySearchResult[]>;
}

export function createUnifiedSearch(deps: UnifiedSearchDeps = {}): UnifiedSearch {
	const logger = (deps as { logger?: Console }).logger ?? console;

	async function searchUnifiedMemory(input: UnifiedMemorySearchInput): Promise<UnifiedMemorySearchOutput> {
		const query = input.query.trim();
		const sources = normalizeUnifiedMemorySearchSources(input.sources);
		const limit = clampUnifiedMemorySearchLimit(input.limit);
		const threshold = clampUnifiedMemorySearchThreshold(input.threshold);
		const warnings: UnifiedMemorySearchWarning[] = [];
		const results: UnifiedMemorySearchResult[] = [];

		if (!query) {
			return {
				query,
				sources,
				results: [],
				count: 0,
				warnings,
			};
		}

		if (sources.includes("memory")) {
			if (isRawMessageStorageAvailable()) {
				try {
					const memoryHits = await runMemorySource(input, limit, threshold);
					results.push(...memoryHits);
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

		if (sources.includes("insights") && typeof deps.searchInsights === "function") {
			try {
				const insightHits = await deps.searchInsights({
					userId: input.userId,
					query: input.query,
					limit,
					threshold,
					botIds: input.botIds,
					includeArchived: input.includeArchivedInsights,
					authToken: input.authToken,
				});
				for (const hit of insightHits) {
					results.push({
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

		if (sources.includes("knowledge") && typeof deps.searchKnowledge === "function") {
			try {
				const knowledgeHits = await deps.searchKnowledge({
					userId: input.userId,
					query: input.query,
					options: {
						limit,
						threshold,
						documentIds: input.documentIds,
					},
					authToken: input.authToken,
				});
				for (const hit of knowledgeHits) {
					results.push(toKnowledgeResult(hit));
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

		const merged = mergeUnifiedMemorySearchResults(results, limit);

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
	): Promise<UnifiedMemorySearchResult[]> {
		if (typeof deps.embedQuery !== "function") {
			throw new Error("embedQuery is not configured");
		}

		const queryEmbedding = await deps.embedQuery({
			userId: input.userId,
			query: input.query,
			authToken: input.authToken,
		});

		const filters = input.botIds && input.botIds.length > 0 ? input.botIds.map((botId) => ({ botId })) : [{}];

		if (isRawMessageChromaEnabled()) {
			try {
				const chromaHits = (
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
					count: chromaHits.length,
				});
				return chromaHits;
			} catch (error) {
				logger.warn?.(
					"[memory-store] Chroma raw message search failed; falling back to database search:",
					error,
				);
				// fall through to the ANN/database search below
			}
		}

		if (typeof deps.searchRawMessagesAnn === "function") {
			const rows = (
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
			return rows;
		}

		return [];
	}

	async function searchRawMemorySemantically(
		input: UnifiedMemorySearchInput,
	): Promise<UnifiedMemorySearchResult[]> {
		const limit = clampUnifiedMemorySearchLimit(input.limit);
		const threshold = clampUnifiedMemorySearchThreshold(input.threshold);
		return runMemorySource(input, limit, threshold);
	}

	return { searchUnifiedMemory, searchRawMemorySemantically };
}
