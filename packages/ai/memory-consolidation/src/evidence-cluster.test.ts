import { describe, expect, it } from "vitest";

import {
	DefaultMemoryEvidenceRecordScorer,
	type MemoryEvidenceRecord,
	analyzeMemoryEvidenceClusters,
	buildMemoryEvidenceClusters,
} from "./evidence-cluster";

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

describe("buildMemoryEvidenceClusters", () => {
	it("returns empty array when no records cluster", () => {
		const records = [record({ id: "a", text: "todo alpha" }), record({ id: "b", text: "todo beta" })];
		const clusters = buildMemoryEvidenceClusters({
			records,
			now: NOW,
			getClusterKey: () => undefined,
		});
		expect(clusters).toHaveLength(0);
	});

	it("groups records by cluster key and sorts by score descending", () => {
		const records = [
			record({ id: "a", text: "deadline", accessCount: 10, timestamp: NOW }),
			record({ id: "b", text: "deadline", accessCount: 5, timestamp: NOW - 86_400_000 }),
			record({ id: "c", text: "note", accessCount: 0, timestamp: NOW }),
		];
		const clusters = buildMemoryEvidenceClusters({
			records,
			now: NOW,
			getClusterKey: (r) => (r.text === "deadline" ? "deadline" : "note"),
		});
		expect(clusters).toHaveLength(2);
		expect(clusters[0].key).toBe("deadline");
		expect(clusters[0].evidenceCount).toBe(2);
		expect(clusters[0].recordIds).toContain("a");
		expect(clusters[0].recordIds).toContain("b");
		expect(clusters[1].key).toBe("note");
		expect(clusters[1].evidenceCount).toBe(1);
		expect(clusters[0].score).toBeGreaterThan(clusters[1].score);
	});

	it("normalizes evidence count against evidenceNorm", () => {
		const records = Array.from({ length: 4 }, (_, i) => record({ id: `r${i}`, text: "same" }));
		const clusters = buildMemoryEvidenceClusters({
			records,
			now: NOW,
			getClusterKey: () => "same",
			evidenceNorm: 8,
		});
		expect(clusters[0].evidenceCount).toBe(4);
		expect(clusters[0].score).toBeLessThan(0.5);
	});

	it("uses custom scorer when provided", () => {
		const records = [record({ id: "a" }), record({ id: "b" })];
		const scorer = { score: () => 0.99 };
		const clusters = buildMemoryEvidenceClusters({
			records,
			now: NOW,
			getClusterKey: () => "k",
			scorer,
		});
		expect(clusters[0].meanRecordScore).toBe(0.99);
	});

	it("respects custom weights", () => {
		const records = [record({ id: "a", accessCount: 0 })];
		const clusters = buildMemoryEvidenceClusters({
			records,
			now: NOW,
			getClusterKey: () => "k",
			weights: { evidence: 1, recordScore: 0, activation: 0, recency: 0 },
		});
		expect(clusters[0].score).toBe(1 / 4);
	});

	it("filters records without a cluster key", () => {
		const records = [record({ id: "a" }), record({ id: "b", metadata: { keep: true } })];
		const clusters = buildMemoryEvidenceClusters({
			records,
			now: NOW,
			getClusterKey: (r) => (r.metadata?.keep ? "keep" : undefined),
		});
		expect(clusters).toHaveLength(1);
		expect(clusters[0].recordIds).toEqual(["b"]);
	});
});

describe("DefaultMemoryEvidenceRecordScorer", () => {
	it("scores pinned records higher", () => {
		const scorer = new DefaultMemoryEvidenceRecordScorer();
		const pinned = scorer.score(record({ isPinned: true }), { now: NOW });
		const unpinned = scorer.score(record({ isPinned: false }), { now: NOW });
		expect(pinned).toBeGreaterThan(unpinned);
	});

	it("scores recent records higher", () => {
		const scorer = new DefaultMemoryEvidenceRecordScorer();
		const recent = scorer.score(record({ timestamp: NOW }), { now: NOW });
		const old = scorer.score(record({ timestamp: NOW - 180 * 86_400_000 }), { now: NOW });
		expect(recent).toBeGreaterThan(old);
	});

	it("infers importance from keywords", () => {
		const scorer = new DefaultMemoryEvidenceRecordScorer();
		const important = scorer.score(record({ text: "urgent deadline decision" }), { now: NOW });
		const plain = scorer.score(record({ text: "hello world" }), { now: NOW });
		expect(important).toBeGreaterThan(plain);
	});
});

describe("analyzeMemoryEvidenceClusters", () => {
	it("flags low-record-score members of high-score clusters", () => {
		const records = [
			record({ id: "strong", text: "deadline", accessCount: 10 }),
			record({ id: "weak", text: "note", accessCount: 0 }),
		];
		const analysis = analyzeMemoryEvidenceClusters({
			records,
			now: NOW,
			getClusterKey: () => "mixed",
			lowRecordScoreThreshold: 0.5,
			highClusterScoreThreshold: 0.1,
		});
		const weakSignal = analysis.recordSignals.find((s) => s.recordId === "weak");
		expect(weakSignal?.lowRecordScoreHighClusterScore).toBe(true);
	});

	it("returns empty analysis for empty records", () => {
		const analysis = analyzeMemoryEvidenceClusters({
			records: [],
			now: NOW,
			getClusterKey: () => "k",
		});
		expect(analysis.clusters).toHaveLength(0);
		expect(analysis.recordSignals).toHaveLength(0);
	});
});
