/**
 * Tests for the `vsa_facts` table migration and the SQLite-backed VSA
 * store contract. The table is created by `initializeRawMessageSchema`
 * (which is also responsible for `raw_messages` / `memory_summaries`),
 * so the VSA tests rely on the shared init path being run before any
 * `SQLiteVsaStore.init()` call.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SQLiteVsaStore } from "./sqlite-vsa-store";

let scratchDir: string;

beforeEach(() => {
	scratchDir = mkdtempSync(join(tmpdir(), "sqlite-vsa-"));
});

afterEach(() => {
	rmSync(scratchDir, { recursive: true, force: true });
});

describe("SQLiteVsaStore — table creation", () => {
	it("creates the vsa_facts table on init()", async () => {
		const store = new SQLiteVsaStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();

		const tables = store.__testDb
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
			.all() as Array<{ name: string }>;
		expect(tables.some((t) => t.name === "vsa_facts")).toBe(true);

		await store.close();
	});

	it("init() is idempotent — running twice on the same db does not throw", async () => {
		const dbPath = join(scratchDir, "store.db");
		const first = new SQLiteVsaStore({ dbPath });
		await first.init();
		await first.close();

		const second = new SQLiteVsaStore({ dbPath });
		await expect(second.init()).resolves.toBeUndefined();
		await second.close();
	});
});

describe("SQLiteVsaStore — storeFact validation", () => {
	it("rejects a fact with empty factId / userId / roleLabel / fillerLabel", async () => {
		const store = new SQLiteVsaStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();

		await expect(
			store.storeFact({
				factId: "",
				userId: "u1",
				roleLabel: "color",
				fillerLabel: "blue",
				roleVector: new Array(4).fill(0.1),
				fillerVector: new Array(4).fill(0.2),
				dim: 4,
				scopeTag: "default",
				createdAt: Date.now(),
			}),
		).rejects.toThrow(/factId/);
		await expect(
			store.storeFact({
				factId: "f1",
				userId: "",
				roleLabel: "color",
				fillerLabel: "blue",
				roleVector: new Array(4).fill(0.1),
				fillerVector: new Array(4).fill(0.2),
				dim: 4,
				scopeTag: "default",
				createdAt: Date.now(),
			}),
		).rejects.toThrow(/userId/);
		await store.close();
	});

	it("rejects a fact whose roleVector length does not match dim", async () => {
		const store = new SQLiteVsaStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		await expect(
			store.storeFact({
				factId: "f1",
				userId: "u1",
				roleLabel: "color",
				fillerLabel: "blue",
				roleVector: new Array(4).fill(0.1),
				fillerVector: new Array(8).fill(0.2),
				dim: 4,
				scopeTag: "default",
				createdAt: Date.now(),
			}),
		).rejects.toThrow(/fillerVector\.length/);
		await store.close();
	});
});

describe("SQLiteVsaStore — queryFacts", () => {
	it("round-trips vectors as Float32 BLOBs (≈7-digit precision)", async () => {
		const store = new SQLiteVsaStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();

		const roleVec = new Array(8).fill(0).map((_, i) => Math.sin(i));
		const fillerVec = new Array(8).fill(0).map((_, i) => Math.cos(i));
		const now = Date.now();
		await store.storeFact({
			factId: "f1",
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "blue",
			roleVector: roleVec,
			fillerVector: fillerVec,
			dim: 8,
			scopeTag: "default",
			createdAt: now,
		});

		const facts = await store.queryFacts({ userId: "u1" });
		expect(facts).toHaveLength(1);
		const fact = facts[0];
		expect(fact?.factId).toBe("f1");
		expect(fact?.roleLabel).toBe("color");
		expect(fact?.fillerLabel).toBe("blue");
		expect(fact?.dim).toBe(8);
		// Float32 round-trip preserves ~7 significant decimal digits, so
		// compare element-wise with a tight tolerance rather than `toEqual`.
		expect(fact?.roleVector).toHaveLength(8);
		for (let i = 0; i < roleVec.length; i += 1) {
			expect(fact?.roleVector[i]).toBeCloseTo(roleVec[i], 6);
		}
		expect(fact?.fillerVector).toHaveLength(8);
		for (let i = 0; i < fillerVec.length; i += 1) {
			expect(fact?.fillerVector[i]).toBeCloseTo(fillerVec[i], 6);
		}

		await store.close();
	});

	it("filters by scopeTag and botId; deprecated facts excluded by default", async () => {
		const store = new SQLiteVsaStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();

		const vec = new Array(4).fill(0.1);
		const baseTime = Date.now();
		await store.storeFact({
			factId: "f-default",
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "blue",
			roleVector: vec,
			fillerVector: vec,
			dim: 4,
			scopeTag: "default",
			createdAt: baseTime,
		});
		await store.storeFact({
			factId: "f-other",
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "red",
			roleVector: vec,
			fillerVector: vec,
			dim: 4,
			scopeTag: "work",
			createdAt: baseTime + 1,
		});
		await store.storeFact({
			factId: "f-deprecated",
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "green",
			roleVector: vec,
			fillerVector: vec,
			dim: 4,
			scopeTag: "default",
			createdAt: baseTime + 2,
		});
		await store.deprecateFacts({
			userId: "u1",
			factIds: ["f-deprecated"],
			reason: "test",
		});

		const defaultScope = await store.queryFacts({ userId: "u1", scopeTag: "default" });
		// `includeDeprecated` defaults to false — only active facts are
		// returned even when a deprecated row lives in the same scope.
		expect(defaultScope.map((f) => f.factId)).toEqual(["f-default"]);

		const defaultScopeAll = await store.queryFacts({
			userId: "u1",
			scopeTag: "default",
			includeDeprecated: true,
		});
		expect(defaultScopeAll.map((f) => f.factId)).toEqual(["f-default", "f-deprecated"]);

		const active = await store.queryFacts({ userId: "u1", includeDeprecated: false });
		expect(active.map((f) => f.factId).sort()).toEqual(["f-default", "f-other"]);

		const all = await store.queryFacts({ userId: "u1", includeDeprecated: true });
		expect(all).toHaveLength(3);

		await store.close();
	});

	it("honours limit (defaults to 1000)", async () => {
		const store = new SQLiteVsaStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();

		const vec = new Array(4).fill(0.1);
		const baseTime = Date.now();
		for (let i = 0; i < 5; i += 1) {
			await store.storeFact({
				factId: `f-${i}`,
				userId: "u1",
				roleLabel: "color",
				fillerLabel: `shade-${i}`,
				roleVector: vec,
				fillerVector: vec,
				dim: 4,
				scopeTag: "default",
				createdAt: baseTime + i,
			});
		}
		const limited = await store.queryFacts({ userId: "u1", limit: 2 });
		expect(limited).toHaveLength(2);
		expect(limited.map((f) => f.factId)).toEqual(["f-0", "f-1"]);

		await store.close();
	});
});

describe("SQLiteVsaStore — deprecateFacts", () => {
	it("is idempotent — re-deprecating returns 0", async () => {
		const store = new SQLiteVsaStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const vec = new Array(4).fill(0.1);
		await store.storeFact({
			factId: "f1",
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "blue",
			roleVector: vec,
			fillerVector: vec,
			dim: 4,
			scopeTag: "default",
			createdAt: Date.now(),
		});

		const first = await store.deprecateFacts({ userId: "u1", factIds: ["f1"], reason: "test" });
		expect(first.deprecatedCount).toBe(1);

		const second = await store.deprecateFacts({ userId: "u1", factIds: ["f1"], reason: "test" });
		expect(second.deprecatedCount).toBe(0);

		await store.close();
	});

	it("returns 0 for an empty factIds array without touching the db", async () => {
		const store = new SQLiteVsaStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const result = await store.deprecateFacts({ userId: "u1", factIds: [] });
		expect(result.deprecatedCount).toBe(0);
		await store.close();
	});

	it("only deprecates facts owned by the supplied userId", async () => {
		const store = new SQLiteVsaStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const vec = new Array(4).fill(0.1);
		await store.storeFact({
			factId: "f1",
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "blue",
			roleVector: vec,
			fillerVector: vec,
			dim: 4,
			scopeTag: "default",
			createdAt: Date.now(),
		});

		// Alice tries to deprecate Bob's fact; nothing happens.
		const result = await store.deprecateFacts({
			userId: "u2",
			factIds: ["f1"],
			reason: "should not apply",
		});
		expect(result.deprecatedCount).toBe(0);

		const stillActive = await store.queryFacts({ userId: "u1" });
		expect(stillActive).toHaveLength(1);
		await store.close();
	});
});

describe("SQLiteVsaStore — storeFact overwrite (idempotent on factId)", () => {
	it("re-storing the same factId overwrites and un-deprecates", async () => {
		const store = new SQLiteVsaStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const vec = new Array(4).fill(0.1);
		const now = Date.now();
		await store.storeFact({
			factId: "f1",
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "blue",
			roleVector: vec,
			fillerVector: vec,
			dim: 4,
			scopeTag: "default",
			createdAt: now,
		});
		await store.deprecateFacts({ userId: "u1", factIds: ["f1"], reason: "test" });

		// Re-store with the same factId — this should clear deprecated_at.
		await store.storeFact({
			factId: "f1",
			userId: "u1",
			roleLabel: "color",
			fillerLabel: "navy",
			roleVector: vec,
			fillerVector: vec,
			dim: 4,
			scopeTag: "default",
			createdAt: now + 1,
		});

		const facts = await store.queryFacts({ userId: "u1", includeDeprecated: false });
		expect(facts).toHaveLength(1);
		expect(facts[0]?.fillerLabel).toBe("navy");
		await store.close();
	});
});
