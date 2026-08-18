/**
 * `reflectWithPlan` write-back loop.
 *
 * Sits on top of the existing `buildMemoryConsolidationPlan` rule-based
 * planner. The LLM never invents new graph operations — it only vets the
 * rule-based plan entries (approve / veto) when the caller wires up a
 * `complete` callback. Persistence flows through two paths:
 *
 *   1. `MemoryGraphStoreWithOperationHistory.persistPlan(plan)` — applied
 *      once per plan, idempotent at the contract level via `operationId`.
 *   2. `MemoryStorageAdapter.deprecateRecords(...)` — called for every
 *      `deprecate` action so the soft-hide chain stays consistent.
 *
 * `buildReflectedConsolidationPlan` is the pure side (no I/O); it returns
 * the plan + warnings. `applyReflectedConsolidationPlan` is the I/O side
 * — it adds persistence + deprecation on top.
 */

import type { MemoryEvidenceRecord } from "./evidence-cluster";
import type {
	MemoryGraphNode,
	MemoryGraphOperation,
	MemoryGraphOperationKind,
	MemoryGraphStoreWithOperationHistory,
	MemoryGraphUpdatePlan,
	MemoryGraphUpdateResult,
	OwnerScope,
} from "./graph-contracts";
import {
	type MemoryConsolidationPlan,
	type MemoryConsolidationPlanEntry,
	type MemoryConsolidationPlanThresholds,
	buildMemoryConsolidationPlan,
} from "./plan";

/**
 * Local mirror of `MemoryDeprecateRecordsInput` from
 * `@melandlabs/ai/memory/contracts`. The contract is structurally
 * stable; defining it here avoids crossing the `rootDir` boundary on
 * this package's tsconfig. The host adapter is expected to be
 * structurally assignable to this shape.
 */
export interface MemoryDeprecateRecordsInput {
	userId: string;
	ids: string[];
	deprecatedAt: number;
	reason?: string;
	supersededBySummaryId?: string;
}

/**
 * Minimal subset of `MemoryStorageAdapter` needed by the planner: just
 * the optional `deprecateRecords` slot. The real contract lives in
 * `@melandlabs/ai/memory/contracts`; declaring a structural alias here
 * keeps this package free of cross-workspace imports.
 */
export interface MemoryStorageAdapterLike {
	deprecateRecords?(input: MemoryDeprecateRecordsInput): Promise<number>;
}

/**
 * Structural mirror of `UnifiedMemorySearchWarning` from
 * `@melandlabs/memory-store/search/utilities`. Kept as a local type so
 * `@melandlabs/memory-consolidation` does not depend on the store
 * package — the two fields are guaranteed by structural compatibility.
 */
export interface UnifiedMemorySearchWarning {
	source: "memory" | "insights" | "knowledge" | string;
	code: string;
	message: string;
}

/** LLM vet callback signature. Mirrors `UnifiedSearchReasoningDeps.complete`. */
export type ReflectPlanReviewFn = (prompt: string) => Promise<string>;

/** Reason-code extension applied when an LLM vetoes an entry. */
const LLM_VETO_REASON_CODE = "llm_veto" as const;

/** Cluster-key selector. Mirrors `BuildMemoryConsolidationPlanInput.getClusterKey`. */
export type ReflectApplyClusterKeyFn = (record: MemoryEvidenceRecord) => string | undefined;

export interface ReflectApplyInput {
	userId: string;
	ownerScope: OwnerScope;
	now?: number;
	/** Evidence records to cluster + classify into actions. Required unless `plan` is supplied. */
	records?: MemoryEvidenceRecord[];
	/** Optional pre-computed plan; bypasses `buildMemoryConsolidationPlan` and lets callers replay / A/B test. */
	plan?: MemoryConsolidationPlan;
	/** LLM vet hook. When present, the planner asks the LLM to approve / veto entries. */
	llmReview?: {
		complete: ReflectPlanReviewFn;
		maxTokens?: number;
	};
	/** When true, plan is built but never persisted / deprecated. */
	dryRun?: boolean;
	/** Optional version check, propagated to `persistPlan.expectedVersion`. */
	expectedVersion?: string;
	/** Thresholds forwarded to `buildMemoryConsolidationPlan`. */
	thresholds?: Partial<MemoryConsolidationPlanThresholds>;
	/** Cluster-key selector forwarded to `buildMemoryConsolidationPlan`. */
	getClusterKey?: ReflectApplyClusterKeyFn;
	/** Competition-key selector forwarded to `buildMemoryConsolidationPlan`. */
	getCompetitionKey?: (cluster: { key: string }) => string | undefined;
}

export interface ReflectApplyOutput {
	plan: MemoryConsolidationPlan;
	persistenceResult?: MemoryGraphUpdateResult;
	/** Per-summary deprecation counts, aggregated across all `deprecate` entries. */
	deprecationCounts?: Array<{ supersededBySummaryId: string; count: number }>;
	warnings: UnifiedMemorySearchWarning[];
	applied: boolean;
}

export interface ApplyReflectApplyInput extends ReflectApplyInput {
	graphStore?: MemoryGraphStoreWithOperationHistory;
	storage?: MemoryStorageAdapterLike;
}

const MAX_ENTRY_PROMPT_CHARS = 600;

function truncate(value: string, max: number = MAX_ENTRY_PROMPT_CHARS): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}

/** Format a single plan entry into a compact text row for the LLM prompt. */
function describeEntry(entry: MemoryConsolidationPlanEntry): string {
	const evidence = entry.evidenceCount;
	const recordIds = entry.recordIds.slice(0, 3).join(",");
	const extras = entry.recordIds.length > 3 ? ` (+${entry.recordIds.length - 3})` : "";
	return `[${entry.action}] cluster=${entry.clusterKey} score=${entry.score.toFixed(3)} evidence=${evidence} reasonCodes=${entry.reasonCodes.join("|")} recordIds=[${recordIds}${extras}] explanation="${truncate(entry.explanation)}"`;
}

function buildReviewPrompt(plan: MemoryConsolidationPlan): string {
	const header = [
		"You are vetting a memory consolidation plan.",
		"For each entry, return a JSON object with shape:",
		'{ "actions": [{ "entryIndex": <number>, "decision": "approve"|"veto", "reason": <short string> }, ...] }',
		"Approve everything by default; only veto entries that look unsafe (e.g. deprecating the only record of a unique experience).",
		"",
		"Entries:",
	].join("\n");
	const body = plan.entries.map((entry, index) => `${index}. ${describeEntry(entry)}`).join("\n");
	return `${header}\n${body}\n\nReturn JSON only.`;
}

/**
 * Best-effort extraction of a JSON payload from an LLM response. Mirrors
 * the helper in `reflect.ts` (`coerceAnswer`) so the two paths agree on
 * edge cases (fenced code, leading prose, etc.).
 */
function extractJsonPayload(text: string): string | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();
	const braceStart = text.indexOf("{");
	const braceEnd = text.lastIndexOf("}");
	if (braceStart >= 0 && braceEnd > braceStart) {
		return text.slice(braceStart, braceEnd + 1);
	}
	return undefined;
}

function parseReviewResponse(
	raw: string,
	plan: MemoryConsolidationPlan,
): {
	approved: Map<number, boolean>;
	reasons: Map<number, string>;
} {
	const approved = new Map<number, boolean>();
	const reasons = new Map<number, string>();
	const payload = extractJsonPayload(raw);
	if (!payload) return { approved, reasons };
	try {
		const parsed = JSON.parse(payload) as { actions?: unknown };
		const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
		for (const action of actions) {
			if (!action || typeof action !== "object") continue;
			const a = action as Record<string, unknown>;
			const index = typeof a.entryIndex === "number" ? a.entryIndex : -1;
			if (index < 0 || index >= plan.entries.length) continue;
			const decision = a.decision === "veto" ? false : a.decision === "approve" ? true : null;
			if (decision === null) continue;
			approved.set(index, decision);
			if (typeof a.reason === "string") reasons.set(index, a.reason);
		}
	} catch {
		// fall through — empty maps = "approve everything"
	}
	return { approved, reasons };
}

/**
 * Build the plan only. Pure side (no I/O). Returns the plan + any warnings
 * raised during LLM review (none when `llmReview` is absent).
 */
export async function buildReflectedConsolidationPlan(input: ReflectApplyInput): Promise<{
	plan: MemoryConsolidationPlan;
	warnings: UnifiedMemorySearchWarning[];
}> {
	const warnings: UnifiedMemorySearchWarning[] = [];

	let plan: MemoryConsolidationPlan;
	if (input.plan) {
		plan = input.plan;
	} else if (!input.getClusterKey) {
		warnings.push({
			source: "memory",
			code: "reflect_apply_plan_cluster_key_missing",
			message: "ReflectApplyInput has no `plan` and no `getClusterKey`; returning an empty plan.",
		});
		plan = {
			clusters: [],
			entries: [],
			actions: { preserve: [], observe: [], decay: [], deprecate: [] },
		};
	} else {
		plan = buildMemoryConsolidationPlan({
			records: input.records ?? [],
			now: input.now ?? Date.now(),
			getClusterKey: input.getClusterKey,
			...(input.getCompetitionKey ? { getCompetitionKey: input.getCompetitionKey } : {}),
			thresholds: input.thresholds,
		});
	}

	if (input.llmReview && plan.entries.length > 0) {
		// Defensive clone: callers may pass a pre-built `input.plan` they intend
		// to re-read (or reuse) after this call. The LLM vet loop below mutates
		// `plan.entries[i]` and `plan.actions` in place, so we must not let those
		// writes escape back to the caller's reference.
		plan = structuredClone(plan);
		try {
			const prompt = buildReviewPrompt(plan);
			const raw = await input.llmReview.complete(prompt);
			const payload = extractJsonPayload(raw);
			if (!payload) {
				warnings.push({
					source: "memory",
					code: "reflect_apply_llm_vet_failed",
					message: "LLM response did not contain a JSON payload; treating all entries as approved.",
				});
			} else {
				const { approved, reasons } = parseReviewResponse(payload, plan);
				// Apply vet: convert vetoed preserve/decay into observe; vetoed
				// deprecate keeps its action but gets an `llm_veto` reason code so
				// callers can opt to skip it at apply time.
				for (let i = 0; i < plan.entries.length; i += 1) {
					const decision = approved.get(i);
					if (decision === undefined || decision === true) continue;
					const original = plan.entries[i];
					const reasonCode: (typeof original.reasonCodes)[number] =
						LLM_VETO_REASON_CODE as (typeof original.reasonCodes)[number];
					const newReasonCodes = original.reasonCodes.includes(reasonCode)
						? original.reasonCodes
						: [...original.reasonCodes, reasonCode];
					const newAction =
						original.action === "preserve" || original.action === "decay" ? "observe" : original.action;
					const reason = reasons.get(i);
					plan.entries[i] = {
						...original,
						action: newAction,
						reasonCodes: newReasonCodes,
						explanation: reason ? `LLM veto: ${reason}` : original.explanation,
					};
				}
			}
		} catch (error) {
			warnings.push({
				source: "memory",
				code: "reflect_apply_llm_vet_failed",
				message: (error as Error).message ?? "LLM vet failed; proceeding with rule-based plan.",
			});
		}
	}

	// Refresh the `actions` buckets in case LLM vet re-categorized entries.
	plan.actions = {
		preserve: plan.entries.filter((entry) => entry.action === "preserve"),
		observe: plan.entries.filter((entry) => entry.action === "observe"),
		decay: plan.entries.filter((entry) => entry.action === "decay"),
		deprecate: plan.entries.filter((entry) => entry.action === "deprecate"),
	};

	if (!input.llmReview) {
		warnings.push({
			source: "memory",
			code: "reflect_apply_llm_skipped",
			message: "No `llmReview.complete` configured; reflecting with rule-based plan only.",
		});
	}

	return { plan, warnings };
}

function translatePlanToGraphUpdate(
	plan: MemoryConsolidationPlan,
	ownerScope: OwnerScope,
	now: number,
	expectedVersion: string | undefined,
): MemoryGraphUpdatePlan {
	const candidateNodes: MemoryGraphNode[] = [];
	const operations: MemoryGraphOperation[] = [];
	const reasonCodes: string[] = [];

	for (const [index, entry] of plan.entries.entries()) {
		if (entry.action === "preserve") {
			for (const recordId of entry.recordIds) {
				candidateNodes.push({
					id: recordId,
					ownerScope,
					type: "raw",
					createdAt: now,
					updatedAt: now,
					visibility: "default",
					metadata: {
						clusterKey: entry.clusterKey,
						competitionKey: entry.competitionKey,
						consolidationScore: entry.score,
						consolidationReasonCodes: entry.reasonCodes,
					},
				});
				operations.push({
					operationId: `preserve:${entry.clusterKey}:${recordId}:${index}`,
					ownerScope,
					kind: "create-node" as MemoryGraphOperationKind,
					nodeIds: [recordId],
					reasonCodes: entry.reasonCodes,
				});
				for (const code of entry.reasonCodes) reasonCodes.push(code);
			}
		}
		if (entry.action === "decay") {
			operations.push({
				operationId: `decay:${entry.clusterKey}:${index}`,
				ownerScope,
				kind: "set-cluster-lifecycle" as MemoryGraphOperationKind,
				nodeIds: entry.recordIds,
				clusterId: entry.clusterKey,
				fromStatus: "active",
				toStatus: "decaying",
				reasonCodes: entry.reasonCodes,
			});
			for (const code of entry.reasonCodes) reasonCodes.push(code);
		}
		if (entry.action === "deprecate") {
			for (const recordId of entry.recordIds) {
				operations.push({
					operationId: `deprecate:${entry.clusterKey}:${recordId}:${index}`,
					ownerScope,
					kind: "supersede-node" as MemoryGraphOperationKind,
					nodeIds: [recordId],
					supersededByNodeId: entry.supersededBySummaryId ?? entry.winningClusterKey,
					reasonCodes: entry.reasonCodes,
				});
				for (const code of entry.reasonCodes) reasonCodes.push(code);
			}
		}
	}

	const updatePlan: MemoryGraphUpdatePlan = {
		ownerScope,
		candidateNodes,
		candidateEdges: [],
		operations,
		persistence: { mode: "write", enabled: true },
		reasonCodes: Array.from(new Set(reasonCodes)),
	};
	if (expectedVersion) updatePlan.expectedVersion = expectedVersion;
	return updatePlan;
}

/** Group deprecate entries by their `supersededBySummaryId`. */
function aggregateDeprecationCounts(plan: MemoryConsolidationPlan): Array<{
	supersededBySummaryId: string;
	count: number;
}> {
	const counts = new Map<string, number>();
	for (const entry of plan.entries) {
		if (entry.action !== "deprecate") continue;
		const key = entry.supersededBySummaryId ?? entry.winningClusterKey;
		if (!key) continue;
		counts.set(key, (counts.get(key) ?? 0) + entry.recordIds.length);
	}
	return Array.from(counts.entries()).map(([supersededBySummaryId, count]) => ({
		supersededBySummaryId,
		count,
	}));
}

/**
 * Apply the plan: persist the graph update + deprecate raw records that the
 * plan marks as superseded. `dryRun: true` skips both writes (still builds
 * the plan). `graphStore` / `storage` are independently optional —
 *   - missing graphStore: skip `persistPlan`, still deprecate.
 *   - missing storage: skip `deprecateRecords`, still persist.
 */
export async function applyReflectedConsolidationPlan(
	input: ApplyReflectApplyInput,
): Promise<ReflectApplyOutput> {
	const { plan, warnings: builtWarnings } = await buildReflectedConsolidationPlan(input);
	const warnings: UnifiedMemorySearchWarning[] = [...builtWarnings];
	const dryRun = input.dryRun ?? false;
	const now = input.now ?? Date.now();

	if (dryRun) {
		return {
			plan,
			deprecationCounts: aggregateDeprecationCounts(plan),
			warnings: [
				...warnings,
				{
					source: "memory",
					code: "reflect_apply_dry_run",
					message: "dryRun: plan built but not persisted.",
				},
			],
			applied: false,
		};
	}

	let persistenceResult: MemoryGraphUpdateResult | undefined;
	let graphWriteAttempted = false;

	if (input.graphStore) {
		graphWriteAttempted = true;
		const updatePlan = translatePlanToGraphUpdate(plan, input.ownerScope, now, input.expectedVersion);
		try {
			persistenceResult = await input.graphStore.persistPlan(updatePlan);
		} catch (error) {
			warnings.push({
				source: "memory",
				code: "reflect_apply_persist_failed",
				message: (error as Error).message ?? "graphStore.persistPlan failed",
			});
		}
	}

	if (input.storage?.deprecateRecords) {
		const deprecateGroups = new Map<string, MemoryConsolidationPlanEntry[]>();
		for (const entry of plan.entries) {
			if (entry.action !== "deprecate") continue;
			const key = entry.supersededBySummaryId ?? entry.winningClusterKey;
			if (!key) continue;
			const list = deprecateGroups.get(key) ?? [];
			list.push(entry);
			deprecateGroups.set(key, list);
		}
		for (const [supersededBySummaryId, entries] of deprecateGroups.entries()) {
			const ids = entries.flatMap((entry) => entry.recordIds);
			// Multiple entries can share a supersededBySummaryId with distinct
			// per-entry deprecation reasons (e.g. one flagged as duplicate, another
			// as stale). Keep every reason so downstream audit / chain-traversal
			// consumers see the full set, joined with a stable separator.
			const reasons = entries.map((entry) => entry.deprecationReason).filter(Boolean) as string[];
			const deprecateInput: MemoryDeprecateRecordsInput = {
				userId: input.userId,
				ids,
				deprecatedAt: now,
				supersededBySummaryId,
			};
			if (reasons.length > 0) deprecateInput.reason = reasons.join("; ");
			try {
				await input.storage.deprecateRecords(deprecateInput);
			} catch (error) {
				warnings.push({
					source: "memory",
					code: "reflect_apply_deprecate_failed",
					message: (error as Error).message ?? "storage.deprecateRecords failed",
				});
			}
		}
	}

	if (!graphWriteAttempted) {
		warnings.push({
			source: "memory",
			code: "reflect_apply_graph_store_not_configured",
			message:
				"No `graphStore` attached; running deprecation-only path. Call `attachMemoryGraphStore` to enable persistPlan.",
		});
	}

	const hasAnyWrites =
		plan.entries.length > 0 &&
		(input.graphStore !== undefined ||
			(input.storage?.deprecateRecords !== undefined && aggregateDeprecationCounts(plan).length > 0));
	if (!hasAnyWrites) {
		warnings.push({
			source: "memory",
			code: "reflect_apply_no_writes",
			message: "Plan built but no write paths were taken (empty plan or all entries observed).",
		});
	}

	return {
		plan,
		persistenceResult,
		deprecationCounts: aggregateDeprecationCounts(plan),
		warnings,
		applied: !dryRun,
	};
}

export const _internal = {
	buildReviewPrompt,
	parseReviewResponse,
	translatePlanToGraphUpdate,
	aggregateDeprecationCounts,
};
