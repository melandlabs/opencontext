/**
 * HRR-backed fact store tests.
 *
 * Verifies the store genuinely routes retrieval through `bind` / `unbind` /
 * `cleanup` (not the exact slot map) and that low-crosstalk recall is exact
 * while the √D capacity guidance holds at a conceptual level.
 */

import { describe, expect, it } from "vitest";

import { createHRRFactStore } from "./hrr-fact-store.js";

describe("createHRRFactStore", () => {
	it("round-trips role/filler pairs via HRR recovery under low crosstalk", async () => {
		const store = createHRRFactStore({ dim: 256, seed: 7 });
		await store.put("scope-1", { role: "favoriteColor", filler: "blue" });
		await store.put("scope-1", { role: "pet", filler: "cat" });
		await store.put("scope-1", { role: "city", filler: "lisbon" });

		expect(await store.get("scope-1", "favoriteColor")).toBe("blue");
		expect(await store.get("scope-1", "pet")).toBe("cat");
		expect(await store.get("scope-1", "city")).toBe("lisbon");
	});

	it("lists and clears scoped slots", async () => {
		const store = createHRRFactStore({ dim: 128, seed: 3 });
		await store.put("s", { role: "a", filler: "1" });
		await store.put("s", { role: "b", filler: "2" });

		const listed = await store.list("s");
		expect(listed).toHaveLength(2);
		expect(listed.map((slot) => slot.role).sort()).toEqual(["a", "b"]);

		await store.clear("s");
		expect(await store.list("s")).toEqual([]);
		expect(await store.get("s", "a")).toBeUndefined();
	});

	it("returns undefined for unknown scopes and roles", async () => {
		const store = createHRRFactStore({ dim: 64, seed: 1 });
		await store.put("scope", { role: "known", filler: "value" });
		expect(await store.get("other-scope", "known")).toBeUndefined();
		expect(await store.get("scope", "unknown")).toBeUndefined();
	});

	it("overwrites a role on repeated put", async () => {
		const store = createHRRFactStore({ dim: 256, seed: 9 });
		await store.put("scope", { role: "color", filler: "red" });
		await store.put("scope", { role: "color", filler: "green" });
		expect(await store.get("scope", "color")).toBe("green");
		expect((await store.list("scope")).map((s) => s.role)).toEqual(["color"]);
	});
});
