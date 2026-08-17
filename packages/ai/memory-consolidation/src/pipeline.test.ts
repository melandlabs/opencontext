import { describe, expect, it } from "vitest";

import type { MemoryEvidenceRecord } from "./evidence-cluster";
import {
	type MemoryRelationCandidate,
	type MemoryRelationJudgmentReasonCode,
	buildMemoryRelationCandidates,
	judgeMemoryRelationCandidates,
} from "./pipeline";

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

describe("buildMemoryRelationCandidates", () => {
	it("returns empty array with no records", () => {
		const candidates = buildMemoryRelationCandidates({
			records: [],
			getCandidateKeys: () => ["k"],
		});
		expect(candidates).toHaveLength(0);
	});

	it("creates candidates for records sharing a key", () => {
		const records = [
			record({ id: "a", metadata: { topic: "t1" } }),
			record({ id: "b", metadata: { topic: "t1" } }),
			record({ id: "c", metadata: { topic: "t2" } }),
		];
		const candidates = buildMemoryRelationCandidates({
			records,
			getCandidateKeys: (r) => [r.metadata?.topic as string],
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0].fromRecordId).toBe("a");
		expect(candidates[0].toRecordId).toBe("b");
		expect(candidates[0].candidateKeys).toContain("t1");
	});

	it("limits candidates per record", () => {
		const records = Array.from({ length: 6 }, (_, i) => record({ id: `r${i}`, metadata: { shared: "x" } }));
		const candidates = buildMemoryRelationCandidates({
			records,
			getCandidateKeys: () => ["shared"],
			maxCandidatesPerRecord: 1,
		});
		const counts = new Map<string, number>();
		for (const c of candidates) {
			counts.set(c.fromRecordId, (counts.get(c.fromRecordId) ?? 0) + 1);
			counts.set(c.toRecordId, (counts.get(c.toRecordId) ?? 0) + 1);
		}
		expect(Math.max(...counts.values())).toBeLessThanOrEqual(1);
	});

	it("limits records per key", () => {
		const records = Array.from({ length: 6 }, (_, i) => record({ id: `r${i}`, metadata: { shared: "x" } }));
		const candidates = buildMemoryRelationCandidates({
			records,
			getCandidateKeys: () => ["shared"],
			maxRecordsPerKey: 3,
		});
		const uniqueIds = new Set(candidates.flatMap((c) => [c.fromRecordId, c.toRecordId]));
		expect(uniqueIds.size).toBeLessThanOrEqual(3);
	});

	it("merges multiple shared keys into one candidate", () => {
		const records = [
			record({ id: "a", metadata: { topics: ["x", "y"] } }),
			record({ id: "b", metadata: { topics: ["x", "y"] } }),
		];
		const candidates = buildMemoryRelationCandidates({
			records,
			getCandidateKeys: (r) => (r.metadata?.topics as string[]) ?? [],
		});
		expect(candidates[0].candidateKeys).toEqual(["x", "y"]);
		expect(candidates[0].score).toBeGreaterThan(0.5);
	});

	it("sorts candidates by score and id deterministically", () => {
		const records = [
			record({ id: "a", metadata: { topics: ["x"] } }),
			record({ id: "b", metadata: { topics: ["x", "y"] } }),
			record({ id: "c", metadata: { topics: ["x", "y", "z"] } }),
		];
		const candidates = buildMemoryRelationCandidates({
			records,
			getCandidateKeys: (r) => (r.metadata?.topics as string[]) ?? [],
		});
		expect(candidates[0].score).toBeGreaterThanOrEqual(candidates[1].score);
	});
});

describe("judgeMemoryRelationCandidates", () => {
	it("judges same relation value as support", () => {
		const records = [
			record({ id: "a", metadata: { relationGroup: "g", relationValue: "v1" } }),
			record({ id: "b", metadata: { relationGroup: "g", relationValue: "v1" } }),
		];
		const candidate: MemoryRelationCandidate = {
			id: "a:b",
			fromRecordId: "a",
			toRecordId: "b",
			candidateKeys: ["k"],
			score: 1,
			reasonCodes: ["shared_candidate_key"],
		};
		const result = judgeMemoryRelationCandidates({
			candidates: [candidate],
			records,
			now: NOW,
		});
		expect(result.relations).toHaveLength(1);
		expect(result.relations[0].relation).toBe("support");
		expect(result.judgments[0].reasonCodes).toContain("same_relation_value");
	});

	it("judges different relation value as compete", () => {
		const records = [
			record({ id: "a", metadata: { relationGroup: "g", relationValue: "v1" } }),
			record({ id: "b", metadata: { relationGroup: "g", relationValue: "v2" } }),
		];
		const candidate: MemoryRelationCandidate = {
			id: "a:b",
			fromRecordId: "a",
			toRecordId: "b",
			candidateKeys: ["k"],
			score: 1,
			reasonCodes: ["shared_candidate_key"],
		};
		const result = judgeMemoryRelationCandidates({
			candidates: [candidate],
			records,
			now: NOW,
		});
		expect(result.relations[0].relation).toBe("compete");
		expect(result.judgments[0].reasonCodes).toContain("different_relation_value");
	});

	it("falls back to related for high score when no group match", () => {
		const records = [record({ id: "a" }), record({ id: "b" })];
		const candidate: MemoryRelationCandidate = {
			id: "a:b",
			fromRecordId: "a",
			toRecordId: "b",
			candidateKeys: ["k"],
			score: 1,
			reasonCodes: ["shared_candidate_key"],
		};
		const result = judgeMemoryRelationCandidates({
			candidates: [candidate],
			records,
			now: NOW,
			thresholds: { relatedScore: 0.5 },
		});
		expect(result.relations[0].relation).toBe("related");
	});

	it("returns uncertain when score is below threshold", () => {
		const records = [record({ id: "a" }), record({ id: "b" })];
		const candidate: MemoryRelationCandidate = {
			id: "a:b",
			fromRecordId: "a",
			toRecordId: "b",
			candidateKeys: ["k"],
			score: 0.1,
			reasonCodes: ["shared_candidate_key"],
		};
		const result = judgeMemoryRelationCandidates({
			candidates: [candidate],
			records,
			now: NOW,
			thresholds: { relatedScore: 0.5 },
		});
		expect(result.relations).toHaveLength(0);
		expect(result.judgments[0].relation).toBe("uncertain");
	});

	it("skips candidates with missing records", () => {
		const records = [record({ id: "a" })];
		const candidate: MemoryRelationCandidate = {
			id: "a:b",
			fromRecordId: "a",
			toRecordId: "missing",
			candidateKeys: ["k"],
			score: 1,
			reasonCodes: ["shared_candidate_key"],
		};
		const result = judgeMemoryRelationCandidates({
			candidates: [candidate],
			records,
			now: NOW,
		});
		expect(result.judgments).toHaveLength(0);
		expect(result.relations).toHaveLength(0);
	});

	it("uses custom judgeCandidate override", () => {
		const records = [record({ id: "a" }), record({ id: "b" })];
		const candidate: MemoryRelationCandidate = {
			id: "a:b",
			fromRecordId: "a",
			toRecordId: "b",
			candidateKeys: ["k"],
			score: 0.1,
			reasonCodes: ["shared_candidate_key"],
		};
		const result = judgeMemoryRelationCandidates({
			candidates: [candidate],
			records,
			now: NOW,
			judgeCandidate: () => ({
				relation: "support",
				weight: 0.9,
				reasonCodes: ["custom" as MemoryRelationJudgmentReasonCode],
			}),
		});
		expect(result.relations[0].relation).toBe("support");
		expect(result.relations[0].weight).toBe(0.9);
		expect(result.judgments[0].reasonCodes).toContain("custom");
	});
});
