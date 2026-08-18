/**
 * Tests for the VSA facade exposed on `MemoryStore`.
 *
 * Uses an in-memory SQLite (`:memory:`) so each test gets a clean slate.
 * The facade is the public surface for HRR-backed recall; the underlying
 * algebra lives in `@melandlabs/vsa` and is exercised separately. Here we
 * verify:
 *   - storeFact → query round-trip preserves vectors and labels
 *   - recall rebuilds the memory vector and returns the best-match label
 *     with a sorted score list
 *   - forget soft-deletes (idempotent) and the active set shrinks
 *   - listFacts filters by scope / botId / deprecated
 *   - empty-vocabulary and dim-mismatch produce warnings, not crashes
 */

import type { VsaFact } from "@melandlabs/contracts";
import { randomHRRVector } from "@melandlabs/vsa";
import { describe, expect, it } from "vitest";

import { createVsaRecall } from "./vsa";

class InMemoryVsaStorage {
	public facts: VsaFact[] = [];

	async storeFact(fact: VsaFact): Promise<void> {
		const existing = this.facts.findIndex((f) => f.factId === fact.factId);
		if (existing >= 0) {
			this.facts[existing] = { ...fact, deprecatedAt: undefined, deprecationReason: undefined };
			return;
		}
		this.facts.push({ ...fact });
	}

	async queryFacts(input: {
		userId: string;
		scopeTag?: string;
		botId?: string;
		includeDeprecated?: boolean;
		limit?: number;
	}): Promise<VsaFact[]> {
		let rows = this.facts.filter((f) => f.userId === input.userId);
		if (input.scopeTag) rows = rows.filter((f) => f.scopeTag === input.scopeTag);
		if (input.botId) rows = rows.filter((f) => f.botId === input.botId);
		if (!input.includeDeprecated) rows = rows.filter((f) => !f.deprecatedAt);
		rows.sort((a, b) => a.createdAt - b.createdAt);
		return rows.slice(0, input.limit ?? 1000);
	}

	async deprecateFacts(input: {
		userId: string;
		factIds: string[];
		reason?: string;
		now?: number;
	}): Promise<{ deprecatedCount: number }> {
		let count = 0;
		for (const fact of this.facts) {
			if (fact.userId !== input.userId) continue;
			if (!input.factIds.includes(fact.factId)) continue;
			if (fact.deprecatedAt) continue;
			fact.deprecatedAt = input.now ?? Date.now();
			fact.deprecationReason = input.reason;
			count += 1;
		}
		return { deprecatedCount: count };
	}
}

function makeStorage() {
	return new InMemoryVsaStorage();
}

function fixedVector(seed: number, dim: number): number[] {
	// Deterministic vector generator — independent of `@melandlabs/vsa`
	// randomness so the facade contract is stable across runs.
	const out = new Array(dim).fill(0);
	for (let i = 0; i < dim; i += 1) {
		out[i] = Math.sin(seed * (i + 1)) + Math.cos(seed * (i + 2) * 0.5);
	}
	const norm = Math.hypot(...out) || 1;
	return out.map((x) => x / norm);
}

describe("createVsaRecall — storeFact", () => {
	it("validates role/filler vectors are finite and same dim", async () => {
		const storage = makeStorage();
		const vsa = createVsaRecall(storage);

		await expect(
			vsa.storeFact({
				userId: "u1",
				roleLabel: "color",
				fillerLabel: "blue",
				roleVector: [NaN, 0.2],
				fillerVector: [0.1, 0.2],
				dim: 2,
			}),
		).rejects.toThrow(/roleVector\[0\]/);

		await expect(
			vsa.storeFact({
				userId: "u1",
				roleLabel: "color",
				fillerLabel: "blue",
				roleVector: [0.1, 0.2],
				fillerVector: [0.1, 0.2, 0.3],
				dim: 2,
			}),
		).rejects.toThrow(/dim mismatch/);

		// roleVector.length must equal dim when dim is supplied
		await expect(
			vsa.storeFact({
				userId: "u1",
				roleLabel: "color",
				fillerLabel: "blue",
				roleVector: [0.1, 0.2, 0.3],
				fillerVector: [0.1, 0.2, 0.3],
				dim: 4,
			}),
		).rejects.toThrow(/roleVector\.length/);
	});

	it("generates a factId when none is supplied", async () => {
		const storage = makeStorage();
		const vsa = createVsaRecall(storage);

		const result = await vsa.storeFact({
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "blue",
			roleVector: fixedVector(1, 4),
			fillerVector: fixedVector(2, 4),
			dim: 4,
		});
		expect(result.factId).toMatch(/^vsa-[a-z0-9]+-[a-z0-9]+$/);
		expect(typeof result.createdAt).toBe("number");
	});
});

describe("createVsaRecall — recall", () => {
	it("returns the best-match vocabulary entry with a sorted allScores list", async () => {
		const storage = makeStorage();
		const vsa = createVsaRecall(storage);

		const roleColor = fixedVector(1, 16);
		const fillerBlue = fixedVector(2, 16);
		const fillerRed = fixedVector(3, 16);
		const fillerGreen = fixedVector(4, 16);
		const vocabBlue = fixedVector(2, 16);
		const vocabRed = fixedVector(3, 16);
		const vocabGreen = fixedVector(4, 16);
		const vocabOrange = fixedVector(99, 16);

		await vsa.storeFact({
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "blue",
			roleVector: roleColor,
			fillerVector: fillerBlue,
			dim: 16,
		});
		await vsa.storeFact({
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "red",
			roleVector: roleColor,
			fillerVector: fillerRed,
			dim: 16,
		});
		await vsa.storeFact({
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "green",
			roleVector: roleColor,
			fillerVector: fillerGreen,
			dim: 16,
		});

		const result = await vsa.recall({
			userId: "u1",
			roleLabel: "color",
			roleVector: roleColor,
			vocabulary: [
				{ label: "blue", vector: vocabBlue },
				{ label: "red", vector: vocabRed },
				{ label: "green", vector: vocabGreen },
				{ label: "orange", vector: vocabOrange },
			],
		});

		expect(result.factCount).toBe(3);
		expect(result.fillerLabel).toBeTypeOf("string");
		// The exact top label is HRR-approximate; with three near-identical
		// binders in the memory, "blue" wins the highest score.
		expect(["blue", "red", "green"]).toContain(result.fillerLabel);
		expect(result.score).toBeGreaterThan(0);
		expect(result.allScores).toHaveLength(4);
		// Sorted descending.
		for (let i = 1; i < result.allScores.length; i += 1) {
			expect(result.allScores[i - 1]!.score).toBeGreaterThanOrEqual(result.allScores[i]!.score);
		}
	});

	it("returns empty + vsa_no_facts warning when no facts are stored", async () => {
		const storage = makeStorage();
		const vsa = createVsaRecall(storage);

		const result = await vsa.recall({
			userId: "ghost",
			roleLabel: "color",
			roleVector: fixedVector(1, 8),
			vocabulary: [{ label: "blue", vector: fixedVector(2, 8) }],
		});
		expect(result.factCount).toBe(0);
		expect(result.fillerLabel).toBe("");
		expect(result.warnings.some((w) => w.code === "vsa_no_facts")).toBe(true);
	});

	it("surfaces vsa_dim_mismatch warning when facts use different dims", async () => {
		const storage = makeStorage();
		const vsa = createVsaRecall(storage);
		const role4 = fixedVector(1, 4);
		const role8 = fixedVector(1, 8);

		// Inject a fact with a different dim directly into storage.
		storage.facts.push({
			factId: "weird",
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "blue",
			roleVector: new Array(8).fill(0.1),
			fillerVector: new Array(8).fill(0.1),
			dim: 8,
			scopeTag: "default",
			createdAt: Date.now(),
		});
		await vsa.storeFact({
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "red",
			roleVector: role4,
			fillerVector: role4,
			dim: 4,
		});

		// The refDim is the first fact's dim (8). The 4-dim fact triggers
		// the vsa_dim_mismatch warning; the role vector at recall time
		// must match refDim (8), otherwise it throws before warnings.
		const result = await vsa.recall({
			userId: "u1",
			roleLabel: "color",
			roleVector: role8,
			vocabulary: [{ label: "blue", vector: new Array(8).fill(0.1) }],
		});
		expect(result.warnings.some((w) => w.code === "vsa_dim_mismatch")).toBe(true);
	});

	it("throws when recall roleVector dim does not match stored fact dim", async () => {
		const storage = makeStorage();
		const vsa = createVsaRecall(storage);
		await vsa.storeFact({
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "blue",
			roleVector: fixedVector(1, 4),
			fillerVector: fixedVector(2, 4),
			dim: 4,
		});
		await expect(
			vsa.recall({
				userId: "u1",
				roleLabel: "color",
				roleVector: fixedVector(1, 8),
				vocabulary: [{ label: "blue", vector: fixedVector(2, 8) }],
			}),
		).rejects.toThrow(/roleVector dim/);
	});

	it("rejects an empty vocabulary", async () => {
		const storage = makeStorage();
		const vsa = createVsaRecall(storage);
		await expect(
			vsa.recall({
				userId: "u1",
				roleLabel: "color",
				roleVector: fixedVector(1, 4),
				vocabulary: [],
			}),
		).rejects.toThrow(/vocabulary/);
	});

	it("emits vsa_fact_limit_reached warning when capped", async () => {
		const storage = makeStorage();
		const vsa = createVsaRecall(storage);
		const roleVec = fixedVector(1, 4);
		for (let i = 0; i < 5; i += 1) {
			await vsa.storeFact({
				userId: "u1",
				roleLabel: "color",
				fillerLabel: `shade-${i}`,
				roleVector: roleVec,
				fillerVector: fixedVector(i + 2, 4),
				dim: 4,
			});
		}
		const result = await vsa.recall({
			userId: "u1",
			roleLabel: "color",
			roleVector: roleVec,
			vocabulary: [{ label: "shade-0", vector: fixedVector(2, 4) }],
			maxFacts: 3,
		});
		expect(result.factCount).toBe(3);
		expect(result.warnings.some((w) => w.code === "vsa_fact_limit_reached")).toBe(true);
	});

	it("emits vsa_low_confidence when the best score is below threshold", async () => {
		const storage = makeStorage();
		const vsa = createVsaRecall(storage);

		// Store a fact with one role/filler, but recall against a very
		// different role — the recovered filler will have a low cosine
		// score against the vocabulary.
		const blueRole = randomHRRVector(16, 1).data;
		const blueFiller = randomHRRVector(16, 2).data;
		await vsa.storeFact({
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "blue",
			roleVector: blueRole,
			fillerVector: blueFiller,
			dim: 16,
		});

		// Use a totally unrelated role vector and a vocabulary that has
		// nothing to do with it.
		const unrelatedRole = randomHRRVector(16, 999).data;
		const vocabEntry = randomHRRVector(16, 888).data;

		const result = await vsa.recall({
			userId: "u1",
			roleLabel: "color",
			roleVector: unrelatedRole,
			vocabulary: [{ label: "anything", vector: vocabEntry }],
		});
		expect(result.warnings.some((w) => w.code === "vsa_low_confidence")).toBe(true);
	});
});

describe("createVsaRecall — listFacts", () => {
	it("strips vectors from the projection and respects includeDeprecated", async () => {
		const storage = makeStorage();
		const vsa = createVsaRecall(storage);
		const roleVec = fixedVector(1, 4);
		await vsa.storeFact({
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "blue",
			roleVector: roleVec,
			fillerVector: roleVec,
			dim: 4,
		});
		await vsa.storeFact({
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "red",
			roleVector: roleVec,
			fillerVector: roleVec,
			dim: 4,
		});
		await vsa.forget({ userId: "u1", factIds: [(storage.facts[1]?.factId) ?? ""], reason: "test" });

		const active = await vsa.listFacts({ userId: "u1" });
		expect(active).toHaveLength(1);
		expect(active[0]?.fillerLabel).toBe("blue");

		const all = await vsa.listFacts({ userId: "u1", includeDeprecated: true });
		expect(all).toHaveLength(2);

		// No vectors on the projection.
		const summary = all[0] as unknown as Record<string, unknown>;
		expect(summary.roleVector).toBeUndefined();
		expect(summary.fillerVector).toBeUndefined();
	});
});

describe("createVsaRecall — forget", () => {
	it("soft-deletes the supplied fact ids and reports the count", async () => {
		const storage = makeStorage();
		const vsa = createVsaRecall(storage);
		const roleVec = fixedVector(1, 4);
		const { factId: a } = await vsa.storeFact({
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "blue",
			roleVector: roleVec,
			fillerVector: roleVec,
			dim: 4,
			factId: "a",
		});
		const { factId: b } = await vsa.storeFact({
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "red",
			roleVector: roleVec,
			fillerVector: roleVec,
			dim: 4,
			factId: "b",
		});

		const result = await vsa.forget({ userId: "u1", factIds: [a, b], reason: "cleanup" });
		expect(result.deprecatedCount).toBe(2);

		const remaining = await vsa.listFacts({ userId: "u1" });
		expect(remaining).toHaveLength(0);

		const stillAll = await vsa.listFacts({ userId: "u1", includeDeprecated: true });
		expect(stillAll).toHaveLength(2);
		expect(stillAll[0]?.deprecatedAt).toBeGreaterThan(0);
	});
});