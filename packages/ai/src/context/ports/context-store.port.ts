import type {
	InsightInput,
	InsightWriteResult,
	InsightsBackendPort,
	InsightsCompactionResult,
} from "./insights-backend.port";
import type { KnowledgeBackendPort } from "./knowledge-backend.port";
import type {
	MemoryBackendPort,
	MemoryForgettingCycleResult,
	MemoryRecordInput,
	MemoryWriteResult,
} from "./memory-backend.port";
import type { ContextHit, ContextQuery, ContextSnapshot, ContextSource } from "./shared";

export interface ContextMaintenanceInput {
	userId: string;
	dryRun?: boolean;
	deprecateSourceRecords?: boolean;
	/** When true, run insights compaction in addition to memory forgetting. */
	compactInsights?: boolean;
}

export interface ContextMaintenanceResult {
	memory?: MemoryForgettingCycleResult;
	insights?: InsightsCompactionResult;
}

/**
 * Unified facade that fans calls out to the three backend ports.
 *
 * - `search` / `snapshot`           — read path (memory + insights + knowledge).
 * - `remember` / `addInsight`       — write path (memory + insights).
 * - `runMaintenance`                — lifecycle (forgetting cycle + compaction).
 *
 * Each call delegates to a typed backend port; the facade never imports
 * concrete storage / search implementations.
 */
export interface ContextStore {
	/** Fan out to the requested sources and return a sorted, merged hit list. */
	search(query: ContextQuery): Promise<ContextHit[]>;

	/**
	 * Same as `search` but also returns the per-source partition and any
	 * non-fatal warnings (e.g. one backend unavailable).
	 */
	snapshot(query: ContextQuery): Promise<ContextSnapshot>;

	/** Write a memory record via the configured `MemoryBackendPort`. */
	remember(record: MemoryRecordInput): Promise<MemoryWriteResult>;

	/** Write an insight via the configured `InsightsBackendPort`. */
	addInsight(input: InsightInput): Promise<InsightWriteResult>;

	/**
	 * Run the maintenance cycle. Memory forgetting runs when
	 * `MemoryBackendPort.runForgettingCycle` is implemented. Insights
	 * compaction runs when `InsightsBackendPort.compact` is implemented AND
	 * `input.compactInsights` is true.
	 */
	runMaintenance(input: ContextMaintenanceInput): Promise<ContextMaintenanceResult>;
}

export interface CreateContextStoreInput {
	memory: MemoryBackendPort;
	insights: InsightsBackendPort;
	knowledge: KnowledgeBackendPort;
}

/**
 * Hint about which backend was hit. Exposed via the `ContextSnapshot` so
 * callers can render provenance without re-running the search.
 */
export type { ContextSource };
