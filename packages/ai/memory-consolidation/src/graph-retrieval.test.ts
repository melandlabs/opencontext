import { describe, expect, it } from "vitest";

import type { MemoryGraphSnapshot } from "./graph-contracts";
import { buildGraphAwareRetrievalDryRun } from "./graph-retrieval";

const OWNER = { userId: "u1" };
const NOW = 1_700_000_000_000;

function snapshot(overrides: Partial<MemoryGraphSnapshot> = {}): MemoryGraphSnapshot {
	return {
		ownerScope: OWNER,
		nodes: [],
		edges: [],
		clusters: [],
		capturedAt: NOW,
		...overrides,
	};
}

describe("buildGraphAwareRetrievalDryRun", () => {
	it("returns baseline nodes that exist and are visible", () => {
		const result = buildGraphAwareRetrievalDryRun({
			ownerScope: OWNER,
			query: "q",
			baselineNodeIds: ["n1", "n2"],
			snapshot: snapshot({
				nodes: [
					{ id: "n1", ownerScope: OWNER, type: "raw", createdAt: NOW, visibility: "default" },
					{ id: "n2", ownerScope: OWNER, type: "raw", createdAt: NOW, visibility: "default" },
				],
			}),
			visibilityMode: "default",
		});
		expect(result.rankedNodeIds).toEqual(["n1", "n2"]);
		expect(result.withheldBaselineNodes).toHaveLength(0);
	});

	it("withholds missing baseline nodes", () => {
		const result = buildGraphAwareRetrievalDryRun({
			ownerScope: OWNER,
			query: "q",
			baselineNodeIds: ["missing"],
			snapshot: snapshot({ nodes: [] }),
			visibilityMode: "default",
		});
		expect(result.rankedNodeIds).toHaveLength(0);
		expect(result.withheldBaselineNodes).toEqual([{ nodeId: "missing", reason: "absent-from-graph" }]);
	});

	it("hides deprecated raw nodes by default", () => {
		const result = buildGraphAwareRetrievalDryRun({
			ownerScope: OWNER,
			query: "q",
			baselineNodeIds: ["n1"],
			snapshot: snapshot({
				nodes: [{ id: "n1", ownerScope: OWNER, type: "raw", createdAt: NOW, visibility: "deprecated" }],
			}),
			visibilityMode: "default",
		});
		expect(result.rankedNodeIds).toHaveLength(0);
		expect(result.hiddenDeprecatedNodeIds).toEqual(["n1"]);
		expect(result.withheldBaselineNodes[0].reason).toBe("deprecated");
	});

	it("includes deprecated nodes when requested", () => {
		const result = buildGraphAwareRetrievalDryRun({
			ownerScope: OWNER,
			query: "q",
			baselineNodeIds: ["n1"],
			snapshot: snapshot({
				nodes: [{ id: "n1", ownerScope: OWNER, type: "raw", createdAt: NOW, visibility: "deprecated" }],
			}),
			visibilityMode: "default",
			includeDeprecated: true,
		});
		expect(result.rankedNodeIds).toEqual(["n1"]);
		expect(result.hiddenDeprecatedNodeIds).toHaveLength(0);
		expect(result.reasonCodes).toContain("include_deprecated_requested");
	});

	it("withholds nodes outside owner scope", () => {
		const result = buildGraphAwareRetrievalDryRun({
			ownerScope: OWNER,
			query: "q",
			baselineNodeIds: ["n1"],
			snapshot: snapshot({
				nodes: [
					{ id: "n1", ownerScope: { userId: "u2" }, type: "raw", createdAt: NOW, visibility: "default" },
				],
			}),
			visibilityMode: "default",
		});
		expect(result.rankedNodeIds).toHaveLength(0);
		expect(result.withheldBaselineNodes[0].reason).toBe("out-of-owner-scope");
	});

	it("expands cluster representative for baseline node", () => {
		const result = buildGraphAwareRetrievalDryRun({
			ownerScope: OWNER,
			query: "q",
			baselineNodeIds: ["n1"],
			snapshot: snapshot({
				nodes: [
					{ id: "n1", ownerScope: OWNER, type: "raw", createdAt: NOW, visibility: "default" },
					{ id: "summary", ownerScope: OWNER, type: "summary", createdAt: NOW, visibility: "default" },
				],
				edges: [
					{
						id: "e1",
						ownerScope: OWNER,
						fromNodeId: "n1",
						toNodeId: "summary",
						kind: "supersede",
						weight: 0.9,
						evidenceNodeIds: [],
						reasonCodes: [],
						createdAt: NOW,
					},
				],
				clusters: [
					{
						clusterId: "c1",
						ownerScope: OWNER,
						nodeIds: ["n1"],
						lifecycleStatus: "active",
						representativeNodeId: "summary",
						updatedAt: NOW,
						reasonCodes: [],
					},
				],
			}),
			visibilityMode: "default",
		});
		expect(result.rankedNodeIds).toEqual(["summary", "n1"]);
		expect(result.addedBeyondBaselineNodes).toEqual([
			{ nodeId: "summary", reason: "cluster-representative" },
		]);
		expect(result.expandedClusterIds).toEqual(["c1"]);
	});

	it("exposes conflict alternatives in conflict mode", () => {
		const result = buildGraphAwareRetrievalDryRun({
			ownerScope: OWNER,
			query: "q",
			baselineNodeIds: ["n1"],
			snapshot: snapshot({
				nodes: [
					{ id: "n1", ownerScope: OWNER, type: "raw", createdAt: NOW, visibility: "default" },
					{ id: "n2", ownerScope: OWNER, type: "raw", createdAt: NOW, visibility: "default" },
				],
				edges: [
					{
						id: "e1",
						ownerScope: OWNER,
						fromNodeId: "n1",
						toNodeId: "n2",
						kind: "compete",
						weight: 0.9,
						evidenceNodeIds: [],
						reasonCodes: [],
						createdAt: NOW,
					},
				],
				clusters: [
					{
						clusterId: "c1",
						ownerScope: OWNER,
						nodeIds: ["n1"],
						lifecycleStatus: "active",
						updatedAt: NOW,
						reasonCodes: [],
					},
					{
						clusterId: "c2",
						ownerScope: OWNER,
						nodeIds: ["n2"],
						lifecycleStatus: "active",
						updatedAt: NOW,
						reasonCodes: [],
					},
				],
			}),
			visibilityMode: "conflict",
		});
		expect(result.rankedNodeIds).toContain("n2");
		expect(result.reasonCodes).toContain("competing_alternatives_exposed");
	});

	it("withholds audit-only nodes in default mode", () => {
		const result = buildGraphAwareRetrievalDryRun({
			ownerScope: OWNER,
			query: "q",
			baselineNodeIds: ["n1"],
			snapshot: snapshot({
				nodes: [{ id: "n1", ownerScope: OWNER, type: "raw", createdAt: NOW, visibility: "audit-only" }],
			}),
			visibilityMode: "default",
		});
		expect(result.rankedNodeIds).toHaveLength(0);
		expect(result.withheldBaselineNodes[0].reason).toBe("audit-only");
	});

	it("includes audit-only nodes in audit mode and produces audit trails", () => {
		const result = buildGraphAwareRetrievalDryRun({
			ownerScope: OWNER,
			query: "q",
			baselineNodeIds: ["n1"],
			snapshot: snapshot({
				nodes: [{ id: "n1", ownerScope: OWNER, type: "raw", createdAt: NOW, visibility: "audit-only" }],
			}),
			visibilityMode: "audit",
		});
		expect(result.rankedNodeIds).toEqual(["n1"]);
		expect(result.auditTrail?.length).toBeGreaterThan(0);
		expect(result.reasonCodes).toContain("audit_trail_available");
	});

	it("filters nodes outside applicability window", () => {
		const result = buildGraphAwareRetrievalDryRun({
			ownerScope: OWNER,
			query: "q",
			baselineNodeIds: ["n1"],
			snapshot: snapshot({
				nodes: [
					{
						id: "n1",
						ownerScope: OWNER,
						type: "raw",
						createdAt: NOW,
						visibility: "default",
						applicability: { scope: "task", key: "t1", validUntil: NOW - 1 },
					},
				],
			}),
			visibilityMode: "default",
			applicabilityContexts: [{ scope: "task", key: "t1" }],
		});
		expect(result.rankedNodeIds).toHaveLength(0);
		expect(result.withheldBaselineNodes[0].reason).toBe("out-of-applicability");
	});
});
