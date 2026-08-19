/**
 * `applyReflectedPlan` — agentic write-back facade.
 *
 * Composes the read-only `search({ synthesize })` evidence pipeline with
 * the `applyReflectedConsolidationPlan` write-side so a single call
 * gathers evidence (raw + summaries + insights + knowledge), vets the
 * plan with the LLM (optional), and persists the result to the graph
 * store + storage.
 *
 * Behaviour parity with `search({ synthesize: true })`:
 *   - Reuses the same gather-evidence pipeline so the answer + evidence
 *     are identical to a read-only search call.
 *   - Honours `peerFilter` via the same scope check used by the unified
 *     read pipeline.
 *   - LLM `complete` is the same `deps.reasoning.complete` the read-only
 *     path uses — no new injection point.
 *
 * Write path:
 *   - When `graphStore` is set (either passed in or attached via
 *     `attachMemoryGraphStore`), persists the graph plan via
 *     `MemoryGraphStoreWithOperationHistory.persistPlan`.
 *   - Always runs `storage.deprecateRecords` for `deprecate` entries — the
 *     deprecation chain is the critical path, so it runs even when the
 *     graph store is missing (with a `reflect_apply_graph_store_not_configured`
 *     warning).
 */

import type { MemoryStorageAdapter } from "@melandlabs/ai/memory";
import type { Peer } from "@melandlabs/contracts/peer";
import type {
	ApplyReflectApplyInput,
	MemoryConsolidationPlan,
	MemoryEvidenceRecord,
	MemoryGraphStoreWithOperationHistory,
	MemoryGraphUpdateResult,
	MemoryStorageAdapterLike,
	OwnerScope,
	ReflectApplyClusterKeyFn,
} from "@melandlabs/memory-consolidation";
import { applyReflectedConsolidationPlan } from "@melandlabs/memory-consolidation";
import type { UnifiedSearchDeps } from "../config";
import { createUnifiedSearch } from "./unified-search";
import type { SearchEvidence, SearchInput, SearchSource, SearchTier } from "./utilities";
import {
	type UnifiedMemorySearchWarning,
	clampUnifiedMemorySearchLimit,
	clampUnifiedMemorySearchThreshold,
} from "./utilities";

export interface ApplyConsolidateInput {
	userId: string;
	query: string;
	ownerScope: OwnerScope;
	botIds?: string[];
	dateFrom?: string;
	dateTo?: string;
	tiers?: ReadonlyArray<SearchTier>;
	limit?: number;
	threshold?: number;
	plan?: MemoryConsolidationPlan;
	dryRun?: boolean;
	expectedVersion?: string;
	llmPlanReview?: { maxTokens?: number };
	authToken?: string;
	peerFilter?: ReadonlyArray<Peer>;
	/**
	 * Cluster-key selector forwarded to `buildMemoryConsolidationPlan`.
	 * When omitted, callers should pass a pre-built `plan`.
	 */
	getClusterKey?: ReflectApplyClusterKeyFn;
	/**
	 * Optional storage adapter — falls back to `store.raw` when wired up by
	 * `createMemoryStore`. Required when no `graphStore` is attached and the
	 * caller still wants `deprecateRecords` writes.
	 */
	storage?: MemoryStorageAdapterLike;
	graphStore?: MemoryGraphStoreWithOperationHistory;
}

export interface ApplyConsolidateOutput {
	answer: string;
	plan: MemoryConsolidationPlan;
	persistenceResult?: MemoryGraphUpdateResult;
	deprecationCounts?: Array<{ supersededBySummaryId: string; count: number }>;
	warnings: UnifiedMemorySearchWarning[];
	applied: boolean;
	evidence: SearchEvidence[];
}

const DEFAULT_TIERS: SearchTier[] = ["summary", "raw", "insight", "knowledge"];

interface MemoryStoreLike {
	graphStore?: MemoryGraphStoreWithOperationHistory;
	storage?: MemoryStorageAdapterLike | MemoryStorageAdapter;
}

type MemoryEvidenceTier = MemoryEvidenceRecord["tier"];

/**
 * Map the read-side source/tier vocabulary onto the consolidation
 * `MemoryEvidenceTier` vocabulary. Accepts the full `SearchEvidence.source`
 * union (both `SearchSource` and `SearchTier` shapes), so anything that
 * isn't a `raw` / `summary` hit falls through to `mid`.
 */
function reflectTierToEvidenceTier(source: SearchSource | SearchTier): MemoryEvidenceTier {
	switch (source) {
		case "raw":
			return "short";
		case "summary":
			return "long";
		default:
			return "mid";
	}
}

function toMemoryEvidenceRecord(input: SearchEvidence, fallbackUserId: string): MemoryEvidenceRecord {
	const tier = reflectTierToEvidenceTier(input.source);
	const timestamp = input.timestamp ?? Date.now();
	return {
		id: input.id,
		userId: fallbackUserId,
		timestamp,
		tier,
		text: input.snippet,
		metadata: {
			source: input.source,
			score: input.score,
			...(input.timestamp !== undefined ? { originalTimestamp: input.timestamp } : {}),
		},
	};
}

export async function applyReflectedPlan(
	deps: UnifiedSearchDeps,
	store: MemoryStoreLike,
	input: ApplyConsolidateInput,
	_logger: Pick<Console, "log" | "warn" | "error">,
): Promise<ApplyConsolidateOutput> {
	const query = input.query.trim();
	const warnings: UnifiedMemorySearchWarning[] = [];
	const limit = clampUnifiedMemorySearchLimit(input.limit);
	const threshold = clampUnifiedMemorySearchThreshold(input.threshold);
	const tiers = input.tiers && input.tiers.length > 0 ? input.tiers : DEFAULT_TIERS;

	const searchInput: SearchInput = {
		userId: input.userId,
		query,
		botIds: input.botIds,
		dateFrom: input.dateFrom,
		dateTo: input.dateTo,
		tiers,
		limit,
		threshold,
		authToken: input.authToken,
		peerFilter: input.peerFilter,
		synthesize: true,
	};

	const search = createUnifiedSearch(deps);
	const result = await search.search(searchInput);
	warnings.push(...result.warnings);

	const evidence: SearchEvidence[] = result.evidence.map((item) => ({
		id: item.id,
		source: (item.source as SearchTier) ?? "raw",
		snippet: item.snippet,
		score: item.score,
		timestamp: item.timestamp,
	}));

	const records = evidence.map((item) => toMemoryEvidenceRecord(item, input.userId));

	const applyInput: ApplyReflectApplyInput = {
		userId: input.userId,
		ownerScope: input.ownerScope,
		records,
		plan: input.plan,
		dryRun: input.dryRun,
		expectedVersion: input.expectedVersion,
		getClusterKey: input.getClusterKey ?? defaultClusterKey,
		llmReview: deps.reasoning?.complete
			? {
					complete: deps.reasoning.complete,
					maxTokens: input.llmPlanReview?.maxTokens,
				}
			: undefined,
		graphStore: input.graphStore ?? store.graphStore,
		storage: input.storage ?? store.storage,
	};

	const applyOutput = await applyReflectedConsolidationPlan(applyInput);
	for (const warning of applyOutput.warnings) {
		warnings.push({
			source: "memory",
			code: warning.code,
			message: warning.message,
		});
	}

	const summaryAnswer = makePlanSummary(applyOutput.plan);

	return {
		answer: result.answer ? `${result.answer}\n\nPlan summary:\n${summaryAnswer}` : summaryAnswer,
		plan: applyOutput.plan,
		persistenceResult: applyOutput.persistenceResult,
		deprecationCounts: applyOutput.deprecationCounts,
		warnings,
		applied: applyOutput.applied,
		evidence,
	};
}

function defaultClusterKey(record: MemoryEvidenceRecord): string | undefined {
	return record.text ?? record.id;
}

function makePlanSummary(plan: MemoryConsolidationPlan): string {
	const lines: string[] = [];
	const counts = {
		preserve: plan.actions.preserve.length,
		observe: plan.actions.observe.length,
		decay: plan.actions.decay.length,
		deprecate: plan.actions.deprecate.length,
	};
	lines.push(
		`- preserve=${counts.preserve} observe=${counts.observe} decay=${counts.decay} deprecate=${counts.deprecate}`,
	);
	for (const entry of plan.actions.deprecate.slice(0, 5)) {
		lines.push(
			`  deprecate ${entry.recordIds.length} record(s) from cluster ${entry.clusterKey} -> ${
				entry.supersededBySummaryId ?? entry.winningClusterKey
			}`,
		);
	}
	return lines.join("\n");
}

// Re-export so consumers only need a single import surface.
export type { MemoryStorageAdapter };
