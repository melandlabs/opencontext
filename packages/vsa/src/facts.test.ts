/**
 * Tests for the in-memory `FactStore` implementation.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryFactStore } from "./facts";

describe("createInMemoryFactStore", () => {
	it("returns undefined for an unknown role", async () => {
		const store = createInMemoryFactStore();
		expect(await store.get("user-1", "favoriteColor")).toBeUndefined();
	});

	it("stores and retrieves a fact slot", async () => {
		const store = createInMemoryFactStore();
		await store.put("user-1", { role: "favoriteColor", filler: "blue" });
		expect(await store.get("user-1", "favoriteColor")).toBe("blue");
	});

	it("overwrites a slot with the same role", async () => {
		const store = createInMemoryFactStore();
		await store.put("user-1", { role: "favoriteColor", filler: "blue" });
		await store.put("user-1", { role: "favoriteColor", filler: "green" });
		expect(await store.get("user-1", "favoriteColor")).toBe("green");
	});

	it("isolates scopes", async () => {
		const store = createInMemoryFactStore();
		await store.put("user-1", { role: "favoriteColor", filler: "blue" });
		await store.put("user-2", { role: "favoriteColor", filler: "red" });
		expect(await store.get("user-1", "favoriteColor")).toBe("blue");
		expect(await store.get("user-2", "favoriteColor")).toBe("red");
	});

	it("lists every slot in a scope", async () => {
		const store = createInMemoryFactStore();
		await store.put("user-1", { role: "favoriteColor", filler: "blue" });
		await store.put("user-1", { role: "pet", filler: "cat" });
		const list = await store.list("user-1");
		expect(list).toHaveLength(2);
		expect(list).toContainEqual({ role: "favoriteColor", filler: "blue" });
		expect(list).toContainEqual({ role: "pet", filler: "cat" });
	});

	it("returns an empty list for an unknown scope", async () => {
		const store = createInMemoryFactStore();
		expect(await store.list("user-unknown")).toEqual([]);
	});

	it("clears an entire scope", async () => {
		const store = createInMemoryFactStore();
		await store.put("user-1", { role: "favoriteColor", filler: "blue" });
		await store.put("user-2", { role: "pet", filler: "cat" });
		await store.clear("user-1");
		expect(await store.get("user-1", "favoriteColor")).toBeUndefined();
		expect(await store.list("user-1")).toEqual([]);
		expect(await store.get("user-2", "pet")).toBe("cat");
	});

	it("rejects put with an empty role", async () => {
		const store = createInMemoryFactStore();
		await expect(store.put("user-1", { role: "", filler: "blue" })).rejects.toThrow();
	});

	it("rejects put without a scope", async () => {
		const store = createInMemoryFactStore();
		await expect(store.put("", { role: "favoriteColor", filler: "blue" })).rejects.toThrow();
	});
});
