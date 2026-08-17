import { describe, expect, it } from "vitest";

import type { MemoryEvidenceRecord } from "./evidence-cluster";
import { buildMemoryConsolidationPlan, buildMemoryDeprecationEntry } from "./plan";

const NOW = 1_700_000_000_000;

function record(overrides: Partial<MemoryEvidenceRecord> = {}): MemoryEvidenceRecord {
	return {
		id: "r1",
		userId: "u1",
		timestamp: NOW,
		tier: "short",
		...overrides,
	};
}

describe("buildMemoryConsolidationPlan", () => {
	it("preserves a strong, repeated winner", () => {
		const records = Array.from({ length: 4 }, (_, i) =>
			record({ id: `r${i}`, text: "deadline", accessCount: 5 }),
		);
		const plan = buildMemoryConsolidationPlan({
			records,
			now: NOW,
			getClusterKey: () => "deadline",
			thresholds: { preserveScore: 0.5, preserveEvidence: 3 },
		});
		expect(plan.entries).toHaveLength(1);
		expect(plan.entries[0].action).toBe("preserve");
		expect(plan.entries[0].reasonCodes).toContain("strong_repeated_evidence");
		expect(plan.actions.preserve).toHaveLength(1);
	});

	it("decays weak isolated clusters", () => {
		const plan = buildMemoryConsolidationPlan({
			records: [record({ id: "a", text: "hello" })],
			now: NOW,
			getClusterKey: () => "hello",
			thresholds: { decayScore: 0.5, decayEvidence: 1 },
		});
		expect(plan.entries[0].action).toBe("decay");
		expect(plan.entries[0].reasonCodes).toContain("isolated_low_confidence");
	});

	it("observes clusters in close competition", () => {
		const records = [
			...Array.from({ length: 3 }, (_, i) => record({ id: `a${i}`, text: "alpha", accessCount: 1 })),
			...Array.from({ length: 3 }, (_, i) => record({ id: `b${i}`, text: "beta", accessCount: 1 })),
		];
		const plan = buildMemoryConsolidationPlan({
			records,
			now: NOW,
			getClusterKey: (r) => (r.text === "alpha" ? "alpha" : "beta"),
			getCompetitionKey: () => "competition",
			thresholds: { preserveScore: 0.9, competitionMargin: 0.5 },
		});
		expect(plan.entries.every((e) => e.action === "observe")).toBe(true);
		expect(plan.entries.some((e) => e.reasonCodes.includes("ambiguous_competition"))).toBe(true);
	});

	it("decays clearly outscored clusters with low evidence", () => {
		const records = [
			record({ id: "winner", text: "w", accessCount: 20 }),
			record({ id: "loser", text: "l", accessCount: 0 }),
		];
		const plan = buildMemoryConsolidationPlan({
			records,
			now: NOW,
			getClusterKey: (r) => r.text ?? "x",
			getCompetitionKey: () => "competition",
			thresholds: { preserveEvidence: 2, decayEvidence: 1, competitionMargin: 0.1 },
		});
		expect(plan.entries.find((e) => e.clusterKey === "l")).toMatchObject({
			action: "decay",
			reasonCodes: expect.arrayContaining(["outscored_by_competitor"]),
		});
	});

	it("groups entries by action", () => {
		const records = [
			...Array.from({ length: 4 }, (_, i) => record({ id: `p${i}`, text: "preserve" })),
			record({ id: "d", text: "decay" }),
		];
		const plan = buildMemoryConsolidationPlan({
			records,
			now: NOW,
			getClusterKey: (r) => r.text ?? "x",
			thresholds: { preserveScore: 0.1, preserveEvidence: 2, decayScore: 0.9, decayEvidence: 1 },
		});
		expect(plan.actions.preserve).toHaveLength(1);
		expect(plan.actions.decay).toHaveLength(1);
		expect(plan.actions.observe).toHaveLength(0);
	});

	it("uses cluster key as competition key when getter is omitted", () => {
		const records = [record({ id: "a" }), record({ id: "b" })];
		const plan = buildMemoryConsolidationPlan({
			records,
			now: NOW,
			getClusterKey: () => "k",
		});
		expect(plan.entries[0].competitionKey).toBe("k");
	});
});

describe("buildMemoryDeprecationEntry", () => {
	it("builds a deprecate entry with defaults", () => {
		const entry = buildMemoryDeprecationEntry({
			clusterKey: "k",
			competitionKey: "c",
			recordIds: ["r1", "r2"],
			winningClusterKey: "winner",
			supersededBySummaryId: "s1",
		});
		expect(entry.action).toBe("deprecate");
		expect(entry.clusterKey).toBe("k");
		expect(entry.recordIds).toEqual(["r1", "r2"]);
		expect(entry.supersededBySummaryId).toBe("s1");
		expect(entry.deprecationReason).toBe("superseded_by_summary:s1");
		expect(entry.reasonCodes).toContain("superseded_by_summary");
	});

	it("accepts custom deprecation reason", () => {
		const entry = buildMemoryDeprecationEntry({
			clusterKey: "k",
			competitionKey: "c",
			recordIds: ["r1"],
			winningClusterKey: "winner",
			supersededBySummaryId: "s2",
			reason: "merged",
		});
		expect(entry.deprecationReason).toBe("merged");
	});

	it("copies input arrays", () => {
		const recordIds = ["r1", "r2"];
		const competing = ["c1"];
		const entry = buildMemoryDeprecationEntry({
			clusterKey: "k",
			competitionKey: "c",
			recordIds,
			winningClusterKey: "winner",
			competingClusterKeys: competing,
			supersededBySummaryId: "s1",
		});
		recordIds.push("r3");
		competing.push("c2");
		expect(entry.recordIds).toEqual(["r1", "r2"]);
		expect(entry.competingClusterKeys).toEqual(["c1"]);
	});
});
