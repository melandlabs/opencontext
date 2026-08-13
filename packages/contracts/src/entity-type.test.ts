/**
 * Tests for `@melandlabs/contracts/entity-type`. The enum is the source of
 * truth for cross-runtime entity tagging; the zod schema and the `isEntityType`
 * type guard both have to agree on every literal.
 */
import { describe, expect, it } from "vitest";

import { ENTITY_TYPES, isEntityType } from "./entity-type";
import { EntityTypeSchema } from "./schemas";

describe("EntityType contract", () => {
	it("exposes every literal as both a type and a zod enum value", () => {
		for (const literal of ENTITY_TYPES) {
			expect(isEntityType(literal)).toBe(true);
			const parsed = EntityTypeSchema.safeParse(literal);
			expect(parsed.success).toBe(true);
		}
	});

	it("rejects unknown literals", () => {
		expect(isEntityType("person-ish")).toBe(false);
		const parsed = EntityTypeSchema.safeParse("person-ish");
		expect(parsed.success).toBe(false);
	});

	it("rejects non-string values", () => {
		expect(isEntityType(42)).toBe(false);
		expect(isEntityType(null)).toBe(false);
		expect(isEntityType({ type: "person" })).toBe(false);
		const parsed = EntityTypeSchema.safeParse(42);
		expect(parsed.success).toBe(false);
	});
});
