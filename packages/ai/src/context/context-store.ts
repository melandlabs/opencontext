import type {
	ContextMaintenanceInput,
	ContextMaintenanceResult,
	ContextStore,
	CreateContextStoreInput,
} from "./ports/context-store.port";
import type { InsightsBackendPort, InsightsCompactionInput } from "./ports/insights-backend.port";
import type { KnowledgeBackendPort } from "./ports/knowledge-backend.port";
import type { MemoryBackendPort, MemoryForgettingCycleInput } from "./ports/memory-backend.port";
import {
	ALL_CONTEXT_SOURCES,
	type ContextHit,
	type ContextQuery,
	type ContextSnapshot,
	type ContextSource,
	type ContextWarning,
	DEFAULT_CONTEXT_QUERY_LIMIT,
	DEFAULT_CONTEXT_QUERY_THRESHOLD,
} from "./ports/shared";

/**
 * Clamp helpers — kept as standalone functions so adapters can re-use them
 * when they want consistent behavior across backends.
 */
export function clampContextQueryLimit(limit: unknown): number {
	const parsed = typeof limit === "number" ? limit : Number(limit ?? DEFAULT_CONTEXT_QUERY_LIMIT);
	if (!Number.isFinite(parsed)) return DEFAULT_CONTEXT_QUERY_LIMIT;
	return Math.min(50, Math.max(1, Math.floor(parsed)));
}

export function clampContextQueryThreshold(threshold: unknown): number {
	const parsed =
		typeof threshold === "number" ? threshold : Number(threshold ?? DEFAULT_CONTEXT_QUERY_THRESHOLD);
	if (!Number.isFinite(parsed)) return DEFAULT_CONTEXT_QUERY_THRESHOLD;
	return Math.min(1, Math.max(-1, parsed));
}

function resolveSources(sources: ContextSource[] | undefined): ContextSource[] {
	if (!Array.isArray(sources) || sources.length === 0) {
		return [...ALL_CONTEXT_SOURCES];
	}
	const valid = sources.filter((source): source is ContextSource =>
		(ALL_CONTEXT_SOURCES as readonly string[]).includes(source),
	);
	return valid.length > 0 ? Array.from(new Set(valid)) : [...ALL_CONTEXT_SOURCES];
}

function mergeAndRank(hits: ContextHit[], limit: number): ContextHit[] {
	return [...hits]
		.sort((a, b) => {
			const scoreDelta = b.score - a.score;
			if (scoreDelta !== 0) return scoreDelta;
			return a.source.localeCompare(b.source) || a.id.localeCompare(b.id);
		})
		.slice(0, limit);
}

function partitionBySource(hits: ContextHit[]): Record<ContextSource, ContextHit[]> {
	const bySource: Record<ContextSource, ContextHit[]> = {
		memory: [],
		insights: [],
		knowledge: [],
	};
	for (const hit of hits) {
		bySource[hit.source].push(hit);
	}
	return bySource;
}

async function safeSearch(
	source: ContextSource,
	backend: { search(query: ContextQuery): Promise<ContextHit[]> },
	query: ContextQuery,
	warnings: ContextWarning[],
): Promise<ContextHit[]> {
	try {
		const hits = await backend.search(query);
		// Defensive: enforce the declared source even if the adapter forgot.
		return hits.map((hit) => ({ ...hit, source }));
	} catch (error) {
		warnings.push({
			source,
			code: `${source}_search_failed`,
			message: error instanceof Error ? error.message : `${source} backend failed.`,
		});
		return [];
	}
}

/**
 * Build a `ContextStore` from three backend ports.
 *
 * The factory is the composition root for the unified context layer. Tests
 * pass mock backends; production wires real adapters via the host's
 * composition root. The factory never reads env vars or instantiates
 * storage clients — that is the adapter's job.
 */
export function createContextStore(input: CreateContextStoreInput): ContextStore {
	const memory: MemoryBackendPort = input.memory;
	const insights: InsightsBackendPort = input.insights;
	const knowledge: KnowledgeBackendPort = input.knowledge;

	return {
		async search(rawQuery: ContextQuery): Promise<ContextHit[]> {
			const snapshot = await this.snapshot(rawQuery);
			return snapshot.hits;
		},

		async snapshot(rawQuery: ContextQuery): Promise<ContextSnapshot> {
			const sources = resolveSources(rawQuery.sources);
			const limit = clampContextQueryLimit(rawQuery.limit);
			const threshold = clampContextQueryThreshold(rawQuery.threshold);
			const normalized: ContextQuery = { ...rawQuery, limit, threshold };
			const warnings: ContextWarning[] = [];

			const tasks: Array<Promise<ContextHit[]>> = [];

			if (sources.includes("memory")) {
				tasks.push(safeSearch("memory", memory, normalized, warnings));
			}
			if (sources.includes("insights")) {
				tasks.push(safeSearch("insights", insights, normalized, warnings));
			}
			if (sources.includes("knowledge")) {
				tasks.push(safeSearch("knowledge", knowledge, normalized, warnings));
			}

			const buckets = await Promise.all(tasks);
			const flat = buckets.flat();
			const ranked = mergeAndRank(flat, limit);

			return {
				hits: ranked,
				bySource: partitionBySource(ranked),
				warnings,
			};
		},

		remember(record) {
			return memory.remember(record);
		},

		addInsight(input) {
			return insights.addInsight(input);
		},

		async runMaintenance(input: ContextMaintenanceInput): Promise<ContextMaintenanceResult> {
			const result: ContextMaintenanceResult = {};

			if (memory.runForgettingCycle) {
				const forgettingInput: MemoryForgettingCycleInput = {
					userId: input.userId,
					dryRun: input.dryRun,
					deprecateSourceRecords: input.deprecateSourceRecords,
				};
				result.memory = await memory.runForgettingCycle(forgettingInput);
			}

			if (input.compactInsights && insights.compact) {
				const compactionInput: InsightsCompactionInput = {
					userId: input.userId,
				};
				result.insights = await insights.compact(compactionInput);
			}

			return result;
		},
	};
}

export type { ContextStore };
