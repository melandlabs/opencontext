/**
 * Tests for the additions to `graph-contracts`:
 *   - the new causal `MemoryGraphRelationKind` literals
 *   - the optional `asOf` ISO-8601 timestamp on `MemoryGraphSnapshotQuery`
 *
 * Both additions are pure type-level extensions and must remain backward
 * compatible with the four pre-existing literals / four pre-existing query
 * fields.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import type { MemoryGraphEdge, MemoryGraphRelationKind, MemoryGraphSnapshotQuery } from "./graph-contracts";

describe("MemoryGraphRelationKind causal extensions", () => {
	it("accepts every new literal in the union", () => {
		const causal: MemoryGraphRelationKind = "caused";
		const influenced: MemoryGraphRelationKind = "influenced";
		const precedent: MemoryGraphRelationKind = "precedent-for";
		expect([causal, influenced, precedent]).toHaveLength(3);
		expectTypeOf<MemoryGraphRelationKind>().toEqualTypeOf<
			"support" | "compete" | "related" | "supersede" | "caused" | "influenced" | "precedent-for"
		>();
	});

	it("accepts the new literals on MemoryGraphEdge.kind", () => {
		const edge: MemoryGraphEdge = {
			id: "e1",
			ownerScope: { userId: "u1" },
			fromNodeId: "n1",
			toNodeId: "n2",
			kind: "caused",
			weight: 0.8,
			evidenceNodeIds: [],
			reasonCodes: [],
			createdAt: 1_700_000_000_000,
		};
		expect(edge.kind).toBe("caused");
	});
});

describe("MemoryGraphSnapshotQuery.asOf", () => {
	it("accepts an ISO-8601 string in `asOf`", () => {
		const query: MemoryGraphSnapshotQuery = {
			ownerScope: { userId: "u1" },
			asOf: "2026-01-15T00:00:00Z",
		};
		expect(query.asOf).toBe("2026-01-15T00:00:00Z");
	});

	it("remains optional — omitting `asOf` keeps the legacy shape", () => {
		const query: MemoryGraphSnapshotQuery = { ownerScope: { userId: "u1" } };
		expect(query.asOf).toBeUndefined();
		expect(query.ownerScope.userId).toBe("u1");
	});
});
