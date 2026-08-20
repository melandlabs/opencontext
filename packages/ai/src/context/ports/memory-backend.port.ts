import type { ContextHit, ContextQuery, ContextSource } from "./shared";

/**
 * Memory tier inside the Context Atlas. Re-exported so adapters don't have to
 * reach into `@melandlabs/ai/memory` just to type a record.
 */
export type MemoryBackendTier = "short" | "mid" | "long";

export interface MemoryRecordInput {
	userId: string;
	text: string;
	/** Optional media references (URIs, file paths, embedding ids). */
	mediaRefs?: string[];
	/** Optional structured facets */
	dimensions?: Record<string, string | number | boolean | undefined>;
	importanceScore?: number;
	isPinned?: boolean;
	/** Free-form backend-specific metadata. */
	metadata?: Record<string, unknown>;
	/** Unix ms; defaults to `Date.now()` inside the adapter. */
	timestamp?: number;
	/**
	 * Preferred initial tier. Backends that auto-classify may ignore this.
	 * Defaults to `"short"`.
	 */
	tier?: MemoryBackendTier;
}

export interface MemoryWriteResult {
	recordId: string;
	tier: MemoryBackendTier;
}

export interface MemoryForgettingCycleInput {
	userId: string;
	/** When true, no writes are issued but the engine still reports counters. */
	dryRun?: boolean;
	/**
	 * When true, raw records are soft-deprecated after their summary is saved.
	 * Defaults to true.
	 */
	deprecateSourceRecords?: boolean;
}

export interface MemoryForgettingCycleResult {
	status: "success" | "skipped_locked" | "unsupported";
	summarized: number;
	transitionedRecords: number;
	deprecatedRecords: number;
}

/**
 * Backend port for the "memory" side of the unified context layer.
 *
 * Adapters should wrap whatever tier-aware memory primitives the host exposes
 * and translate between those shapes and the simplified `ContextHit` /
 * `MemoryRecordInput` contracts here.
 *
 * Implementations MUST:
 * - Treat `query.userId` as required and never leak across users.
 * - Honor `query.limit`, `query.threshold`, `query.timeRange` when applicable.
 * - Set `hit.source = "memory"` on every result.
 * - Never throw on unsupported sub-fields — return what they can.
 */
export interface MemoryBackendPort {
	readonly source: ContextSource;

	search(query: ContextQuery): Promise<ContextHit[]>;
	remember(record: MemoryRecordInput): Promise<MemoryWriteResult>;

	/**
	 * Run one tier-transition / forgetting cycle for `userId`. Backends that
	 * have no concept of forgetting (e.g. Hyper MCP) return
	 * `{ status: "unsupported", summarized: 0, ... }`.
	 */
	runForgettingCycle?(input: MemoryForgettingCycleInput): Promise<MemoryForgettingCycleResult>;
}
