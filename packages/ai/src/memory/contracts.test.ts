import { describe, expect, it } from "vitest";

import { type FactType, type MemoryRecord, type MemorySearchQuery, isFactType } from "./contracts";

describe("isFactType", () => {
	it("accepts the three canonical fact types", () => {
		expect(isFactType("world")).toBe(true);
		expect(isFactType("experience")).toBe(true);
		expect(isFactType("mental_model")).toBe(true);
	});

	it("rejects everything else", () => {
		expect(isFactType("preference")).toBe(false);
		expect(isFactType("")).toBe(false);
		expect(isFactType(undefined)).toBe(false);
		expect(isFactType(null)).toBe(false);
		expect(isFactType(0)).toBe(false);
		expect(isFactType({})).toBe(false);
	});
});

describe("MemoryRecord.factType", () => {
	it("round-trips through TypeScript's structural type", () => {
		const record: MemoryRecord = {
			id: "r1",
			userId: "u1",
			timestamp: 1_700_000_000_000,
			tier: "short",
			factType: "experience",
		};
		expect(record.factType).toBe<FactType>("experience");

		const withoutFactType: MemoryRecord = {
			id: "r2",
			userId: "u1",
			timestamp: 1_700_000_000_000,
			tier: "short",
		};
		expect(withoutFactType.factType).toBeUndefined();
	});
});

describe("MemorySearchQuery.factTypes", () => {
	it("accepts an array of fact types", () => {
		const query: MemorySearchQuery = {
			userId: "u1",
			factTypes: ["world", "experience"],
		};
		expect(query.factTypes).toEqual(["world", "experience"]);
	});

	it("is optional and absent-by-default", () => {
		const query: MemorySearchQuery = { userId: "u1" };
		expect(query.factTypes).toBeUndefined();
	});
});
