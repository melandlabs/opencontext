import type { ContextHit, ContextQuery, ContextSource } from "./shared";

export type InsightImportance = "critical" | "high" | "general" | "low";
export type InsightUrgency = "very_urgent" | "urgent" | "not_urgent" | "low_urgency";

export interface InsightInput {
	userId: string;
	botId: string;
	title: string;
	description: string;
	taskLabel: string;
	importance: InsightImportance | string;
	urgency: InsightUrgency | string;
	platform?: string | null;
	account?: string | null;
	/** When the insight is about; defaults to `Date.now()` inside the adapter. */
	time?: Date | null;
	/** Optional idempotency key for the bot/source. */
	dedupeKey?: string;
}

export interface InsightWriteResult {
	insightId: string;
}

export interface InsightsRefreshInput {
	botId: string;
	force?: boolean;
}

export interface InsightsRefreshResult {
	refreshed: number;
}

export interface InsightsCompactionInput {
	userId: string;
}

export interface InsightsCompactionResult {
	merged: number;
	archived: number;
}

/**
 * Backend port for the "insights" side of the unified context layer.
 *
 * Adapters wrap the host's insights pipeline and translate between the host's
 * domain-specific shapes and the simplified shapes defined here.
 */
export interface InsightsBackendPort {
	readonly source: ContextSource;

	search(query: ContextQuery): Promise<ContextHit[]>;
	addInsight(input: InsightInput): Promise<InsightWriteResult>;

	/** Optional: scheduled refresh; backends may return `{ refreshed: 0 }`. */
	refresh?(input: InsightsRefreshInput): Promise<InsightsRefreshResult>;

	/** Optional: run a compaction pass for `userId`. */
	compact?(input: InsightsCompactionInput): Promise<InsightsCompactionResult>;
}
