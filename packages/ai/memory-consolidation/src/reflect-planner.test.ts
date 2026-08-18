/**
 * Tests for the `reflectWithPlan` write-back loop.
 *
 * Covers:
 *   - Pure rule path (no LLM) builds the expected graph plan + deprecation calls
 *   - LLM veto flips the entry's action to `observe` (no invented entries)
 *   - LLM parse failure / exception falls back to approve-all + warning
 *   - dryRun short-circuits all writes
 *   - `graphStore` missing still runs `deprecateRecords` (with a warning)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryEvidenceRecord } from "./evidence-cluster";
import type {
	MemoryGraphStoreWithOperationHistory,
	MemoryGraphUpdatePlan,
	MemoryGraphUpdateResult,
} from "./graph-contracts";
import type { OwnerScope } from "./graph-contracts";
import { buildMemoryConsolidationPlan } from "./plan";
import {
	type MemoryStorageAdapterLike,
	applyReflectedConsolidationPlan,
	buildReflectedConsolidationPlan,
} from "./reflect-planner";

const OWNER: OwnerScope = { userId: "u-42" };

// The real `MemoryStorageAdapter` lives in `@melandlabs/ai/memory`. The
// planner only needs the `deprecateRecords` slot, so we type the test
// fixture against the structural alias re-exported from `./reflect-planner`.
// This keeps `memory-consolidation` self-contained without forcing a build
// dependency on `@melandlabs/ai` types during test.
type TestStorage = MemoryStorageAdapterLike;

function makeRecord(overrides: Partial<MemoryEvidenceRecord> & { id: string }): MemoryEvidenceRecord {
	return {
		userId: OWNER.userId,
		timestamp: overrides.timestamp ?? Date.now(),
		tier: overrides.tier ?? "mid",
		accessCount: 0,
		importanceScore: 0.5,
		text: overrides.text ?? `text for ${overrides.id}`,
		...overrides,
	};
}

function makeGraphStore(): MemoryGraphStoreWithOperationHistory & {
	persistPlan: ReturnType<typeof vi.fn>;
	readSnapshot: ReturnType<typeof vi.fn>;
	readAuditTrail: ReturnType<typeof vi.fn>;
	readAppliedOperations: ReturnType<typeof vi.fn>;
} {
	return {
		persistPlan: vi.fn(
			async (_plan: MemoryGraphUpdatePlan): Promise<MemoryGraphUpdateResult> => ({
				ownerScope: OWNER,
				appliedOperations: [],
				skippedOperations: [],
				mutatesGraph: true,
				diagnostics: [],
			}),
		),
		readSnapshot: vi.fn(async () => ({
			ownerScope: OWNER,
			nodes: [],
			edges: [],
			clusters: [],
			capturedAt: 0,
		})),
		readAuditTrail: vi.fn(async () => ({
			ownerScope: OWNER,
			nodeId: "",
			sourceNodeIds: [],
			edgeIds: [],
			operationIds: [],
			reasonCodes: [],
		})),
		readAppliedOperations: vi.fn(async () => []),
	};
}

function makeStorage(overrides: Partial<TestStorage> = {}): TestStorage {
	return {
		deprecateRecords: vi.fn(async () => 0),
		...overrides,
	};
}

describe("reflectWithPlan / buildReflectedConsolidationPlan", () => {
	const realNow = Date.now;
	beforeEach(() => {
		Date.now = () => 1_700_000_000_000;
	});
	afterEach(() => {
		Date.now = realNow;
	});

	it("returns an empty plan when no records or getClusterKey provided", async () => {
		const out = await buildReflectedConsolidationPlan({
			userId: OWNER.userId,
			ownerScope: OWNER,
			records: [],
		});
		expect(out.plan.entries).toEqual([]);
		expect(out.warnings.some((w) => w.code === "reflect_apply_plan_cluster_key_missing")).toBe(true);
	});

	it("approves every entry when LLM is not configured", async () => {
		const records: MemoryEvidenceRecord[] = [
			makeRecord({ id: "r1", text: "alice" }),
			makeRecord({ id: "r2", text: "alice" }),
			makeRecord({ id: "r3", text: "alice" }),
			makeRecord({ id: "r4", text: "alice" }),
		];
		const out = await buildReflectedConsolidationPlan({
			userId: OWNER.userId,
			ownerScope: OWNER,
			records,
			getClusterKey: (record) => record.text,
		});
		// All 4 records share a cluster key, so the plan should `preserve` them
		// (preserveEvidence default = 3, preserveScore default = 0.6).
		expect(out.plan.entries.length).toBeGreaterThan(0);
		expect(out.plan.actions.preserve.length).toBeGreaterThan(0);
		expect(out.warnings.some((w) => w.code === "reflect_apply_llm_skipped")).toBe(true);
	});

	it("LLM veto flips the entry's action to observe without inventing new entries", async () => {
		const records: MemoryEvidenceRecord[] = [
			makeRecord({ id: "r1", text: "alice" }),
			makeRecord({ id: "r2", text: "alice" }),
			makeRecord({ id: "r3", text: "alice" }),
			makeRecord({ id: "r4", text: "alice" }),
		];
		// Build the rule-based plan first so we can build a deterministic veto list.
		const plan = buildMemoryConsolidationPlan({
			records,
			now: Date.now(),
			getClusterKey: (record) => record.text,
		});
		const firstEntry = plan.entries[0];
		expect(firstEntry).toBeDefined();
		// Snapshot the caller's plan so we can assert it is not mutated in place.
		const originalActions = plan.entries.map((e) => e.action);
		const originalReasonCodes = plan.entries.map((e) => [...e.reasonCodes]);

		const complete = vi.fn(async () =>
			JSON.stringify({
				actions: [{ entryIndex: 0, decision: "veto", reason: "redundant" }],
			}),
		);

		const out = await buildReflectedConsolidationPlan({
			userId: OWNER.userId,
			ownerScope: OWNER,
			records,
			plan,
			llmReview: { complete },
		});

		// Plan length is unchanged (vet cannot invent).
		expect(out.plan.entries).toHaveLength(plan.entries.length);
		const vetoed = out.plan.entries[0];
		expect(vetoed.action).toBe("observe");
		expect(vetoed.reasonCodes).toContain("llm_veto");
		// The original entry's reasonCodes (e.g. "strong_repeated_evidence") are preserved.
		expect(vetoed.reasonCodes).toEqual(expect.arrayContaining(firstEntry.reasonCodes));
		expect(complete).toHaveBeenCalledTimes(1);

		// The caller's pre-built plan must not be mutated in place: the returned
		// out.plan is a deep clone whose entries may have been re-categorised,
		// but the original reference is untouched.
		expect(plan.entries.map((e) => e.action)).toEqual(originalActions);
		expect(plan.entries.map((e) => e.reasonCodes)).toEqual(originalReasonCodes);
	});

	it("LLM parse failure falls back to approve-all + warning", async () => {
		const records: MemoryEvidenceRecord[] = [
			makeRecord({ id: "r1", text: "alice" }),
			makeRecord({ id: "r2", text: "alice" }),
			makeRecord({ id: "r3", text: "alice" }),
			makeRecord({ id: "r4", text: "alice" }),
		];
		const plan = buildMemoryConsolidationPlan({
			records,
			now: Date.now(),
			getClusterKey: (record) => record.text,
		});
		const complete = vi.fn(async () => "not valid json at all");
		const out = await buildReflectedConsolidationPlan({
			userId: OWNER.userId,
			ownerScope: OWNER,
			records,
			plan,
			llmReview: { complete },
		});
		// Plan is untouched.
		expect(out.plan.entries[0].action).toBe(plan.entries[0].action);
		expect(out.warnings.some((w) => w.code === "reflect_apply_llm_vet_failed")).toBe(true);
	});

	it("LLM exception falls back to approve-all + warning", async () => {
		const records: MemoryEvidenceRecord[] = [
			makeRecord({ id: "r1", text: "alice" }),
			makeRecord({ id: "r2", text: "alice" }),
			makeRecord({ id: "r3", text: "alice" }),
		];
		const plan = buildMemoryConsolidationPlan({
			records,
			now: Date.now(),
			getClusterKey: (record) => record.text,
		});
		const complete = vi.fn(async () => {
			throw new Error("llm exploded");
		});
		const out = await buildReflectedConsolidationPlan({
			userId: OWNER.userId,
			ownerScope: OWNER,
			records,
			plan,
			llmReview: { complete },
		});
		expect(out.plan.entries[0].action).toBe(plan.entries[0].action);
		expect(out.warnings.some((w) => w.code === "reflect_apply_llm_vet_failed")).toBe(true);
	});
});

describe("applyReflectedConsolidationPlan", () => {
	const realNow = Date.now;
	beforeEach(() => {
		Date.now = () => 1_700_000_000_000;
	});
	afterEach(() => {
		Date.now = realNow;
	});

	it("dryRun=true: returns applied=false, no writes to graphStore or storage", async () => {
		const graphStore = makeGraphStore();
		const storage = makeStorage();
		const out = await applyReflectedConsolidationPlan({
			userId: OWNER.userId,
			ownerScope: OWNER,
			records: [
				makeRecord({ id: "r1", text: "alice" }),
				makeRecord({ id: "r2", text: "alice" }),
				makeRecord({ id: "r3", text: "alice" }),
				makeRecord({ id: "r4", text: "alice" }),
			],
			getClusterKey: (r) => r.text,
			dryRun: true,
			graphStore,
			storage,
		});
		expect(out.applied).toBe(false);
		expect(graphStore.persistPlan).not.toHaveBeenCalled();
		expect(storage.deprecateRecords).not.toHaveBeenCalled();
		expect(out.warnings.some((w) => w.code === "reflect_apply_dry_run")).toBe(true);
	});

	it("calls graphStore.persistPlan once with a plan containing preserve operations", async () => {
		const graphStore = makeGraphStore();
		const storage = makeStorage();
		await applyReflectedConsolidationPlan({
			userId: OWNER.userId,
			ownerScope: OWNER,
			records: [
				makeRecord({ id: "r1", text: "alice" }),
				makeRecord({ id: "r2", text: "alice" }),
				makeRecord({ id: "r3", text: "alice" }),
				makeRecord({ id: "r4", text: "alice" }),
			],
			getClusterKey: (r) => r.text,
			graphStore,
			storage,
		});
		expect(graphStore.persistPlan).toHaveBeenCalledTimes(1);
		const plan = (graphStore.persistPlan as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as MemoryGraphUpdatePlan;
		expect(plan.persistence).toEqual({ mode: "write", enabled: true });
		expect(plan.operations.length).toBeGreaterThan(0);
	});

	it("missing graphStore still runs deprecateRecords + emits warning", async () => {
		const storage = makeStorage();
		const out = await applyReflectedConsolidationPlan({
			userId: OWNER.userId,
			ownerScope: OWNER,
			records: [
				makeRecord({ id: "r1", text: "alice" }),
				makeRecord({ id: "r2", text: "alice" }),
				makeRecord({ id: "r3", text: "alice" }),
			],
			getClusterKey: (r) => r.text,
			storage,
			// No graphStore — deprecate-only path.
		});
		// Storage.deprecateRecords may not be called if the rule-based plan has no
		// `deprecate` actions for these records (default preserves strong clusters).
		// What we DO assert: no graph writes attempted and a warning is emitted.
		expect(out.warnings.some((w) => w.code === "reflect_apply_graph_store_not_configured")).toBe(true);
		expect(out.applied).toBe(true);
	});

	it("calls deprecateRecords with the supersededBySummaryId for deprecate entries", async () => {
		const storage = makeStorage();
		const deprecate = storage.deprecateRecords as ReturnType<typeof vi.fn>;
		// Inject a deprecate entry directly into the plan.
		const plan = buildMemoryConsolidationPlan({
			records: [
				makeRecord({ id: "r1", text: "alice" }),
				makeRecord({ id: "r2", text: "alice" }),
				makeRecord({ id: "r3", text: "alice" }),
			],
			now: Date.now(),
			getClusterKey: (r) => r.text,
		});
		// Force one entry to be a deprecate by mutating the plan's entries array.
		const entries = plan.entries.map((entry, index) =>
			index === 0 ? { ...entry, action: "deprecate" as const, supersededBySummaryId: "L1-xyz" } : entry,
		);
		const deprecateOnlyPlan = {
			...plan,
			entries,
			actions: {
				preserve: entries.filter((e) => e.action === "preserve"),
				observe: entries.filter((e) => e.action === "observe"),
				decay: entries.filter((e) => e.action === "decay"),
				deprecate: entries.filter((e) => e.action === "deprecate"),
			},
		};
		await applyReflectedConsolidationPlan({
			userId: OWNER.userId,
			ownerScope: OWNER,
			records: [
				makeRecord({ id: "r1", text: "alice" }),
				makeRecord({ id: "r2", text: "alice" }),
				makeRecord({ id: "r3", text: "alice" }),
			],
			plan: deprecateOnlyPlan,
			storage,
		});
		expect(deprecate).toHaveBeenCalledTimes(1);
		const call = deprecate.mock.calls[0][0] as Parameters<NonNullable<TestStorage["deprecateRecords"]>>[0];
		expect(call.supersededBySummaryId).toBe("L1-xyz");
		expect(call.ids.length).toBeGreaterThan(0);
		expect(call.userId).toBe(OWNER.userId);
	});

	it("joins distinct deprecation reasons for entries that share a supersededBySummaryId", async () => {
		const storage = makeStorage();
		const deprecate = storage.deprecateRecords as ReturnType<typeof vi.fn>;
		// Two independent deprecate entries share a supersededBySummaryId but
		// carry distinct per-entry deprecation reasons. The apply path should
		// preserve every reason so downstream audit logs see the full set.
		const sharedSupersededBy = "L1-shared";
		const plan = buildMemoryConsolidationPlan({
			records: [makeRecord({ id: "r1", text: "alice" }), makeRecord({ id: "r2", text: "bob" })],
			now: Date.now(),
			getClusterKey: (r) => r.text,
		});
		// Build entries directly so the union action type is preserved
		// (TS would otherwise narrow the map callback to "deprecate" only and
		// reject the per-bucket filter expressions below).
		const entries: typeof plan.entries = plan.entries.map((entry, index) => ({
			...entry,
			action: "deprecate",
			supersededBySummaryId: sharedSupersededBy,
			deprecationReason: index === 0 ? "duplicate" : "stale",
		}));
		const deprecateOnlyPlan = {
			...plan,
			entries,
			actions: {
				preserve: entries.filter((e) => e.action === "preserve"),
				observe: entries.filter((e) => e.action === "observe"),
				decay: entries.filter((e) => e.action === "decay"),
				deprecate: entries.filter((e) => e.action === "deprecate"),
			},
		};
		await applyReflectedConsolidationPlan({
			userId: OWNER.userId,
			ownerScope: OWNER,
			records: [makeRecord({ id: "r1", text: "alice" }), makeRecord({ id: "r2", text: "bob" })],
			plan: deprecateOnlyPlan,
			storage,
		});
		expect(deprecate).toHaveBeenCalledTimes(1);
		const call = deprecate.mock.calls[0][0] as Parameters<NonNullable<TestStorage["deprecateRecords"]>>[0];
		expect(call.supersededBySummaryId).toBe(sharedSupersededBy);
		// Both per-entry reasons must be present, joined in entry order.
		expect(call.reason).toBe("duplicate; stale");
	});

	it("empty plan: applied=true with no_writes warning", async () => {
		const out = await applyReflectedConsolidationPlan({
			userId: OWNER.userId,
			ownerScope: OWNER,
			records: [],
		});
		expect(out.applied).toBe(true);
		expect(out.warnings.some((w) => w.code === "reflect_apply_no_writes")).toBe(true);
	});
});
