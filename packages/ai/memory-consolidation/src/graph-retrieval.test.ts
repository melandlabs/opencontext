import { describe, expect, it } from "vitest";

import type { MemoryGraphSnapshot } from "./graph-contracts";
import {
	DefaultGraphAwareRetriever,
	applicabilityMatchesTrustedContexts,
	buildGraphAwareRetrievalDryRun,
} from "./graph-retrieval";

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

describe("applicabilityMatchesTrustedContexts", () => {
	it("keeps global memories eligible under every explicit context list", () => {
		expect(applicabilityMatchesTrustedContexts(undefined, [], NOW)).toBe(true);
		expect(applicabilityMatchesTrustedContexts({ scope: "global" }, [], NOW)).toBe(true);
		expect(
			applicabilityMatchesTrustedContexts({ scope: "global" }, [{ scope: "project", key: "project-a" }], NOW),
		).toBe(true);
	});

	it("requires exact scope and key equality for scoped memories", () => {
		const projectA = { scope: "project" as const, key: "project-a" };
		expect(applicabilityMatchesTrustedContexts(projectA, [projectA], NOW)).toBe(true);
		expect(applicabilityMatchesTrustedContexts(projectA, [{ scope: "project", key: "project-b" }], NOW)).toBe(
			false,
		);
		expect(applicabilityMatchesTrustedContexts(projectA, [{ scope: "task", key: "project-a" }], NOW)).toBe(
			false,
		);
		expect(applicabilityMatchesTrustedContexts(projectA, [{ scope: "project" }], NOW)).toBe(false);
		expect(
			applicabilityMatchesTrustedContexts(
				{ scope: "project" },
				[{ scope: "project", key: "project-a" }],
				NOW,
			),
		).toBe(false);
	});

	it("treats multiple trusted contexts as additive", () => {
		const contexts = [
			{ scope: "task" as const, key: "task-a" },
			{ scope: "project" as const, key: "project-b" },
		];
		expect(applicabilityMatchesTrustedContexts({ scope: "task", key: "task-a" }, contexts, NOW)).toBe(true);
		expect(applicabilityMatchesTrustedContexts({ scope: "project", key: "project-b" }, contexts, NOW)).toBe(
			true,
		);
		expect(applicabilityMatchesTrustedContexts({ scope: "project", key: "project-c" }, contexts, NOW)).toBe(
			false,
		);
	});

	it("requires both the memory and its matching context to be active", () => {
		const projectA = { scope: "project" as const, key: "project-a" };
		expect(applicabilityMatchesTrustedContexts({ ...projectA, validFrom: NOW + 1 }, [projectA], NOW)).toBe(
			false,
		);
		expect(applicabilityMatchesTrustedContexts({ ...projectA, validUntil: NOW - 1 }, [projectA], NOW)).toBe(
			false,
		);
		expect(applicabilityMatchesTrustedContexts(projectA, [{ ...projectA, validFrom: NOW + 1 }], NOW)).toBe(
			false,
		);
		expect(applicabilityMatchesTrustedContexts(projectA, [{ ...projectA, validUntil: NOW - 1 }], NOW)).toBe(
			false,
		);
		expect(
			applicabilityMatchesTrustedContexts(
				{ ...projectA, validFrom: NOW, validUntil: NOW },
				[{ ...projectA, validFrom: NOW, validUntil: NOW }],
				NOW,
			),
		).toBe(true);
	});

	it("evaluates windows at the supplied historical instant", () => {
		const projectA = { scope: "project" as const, key: "project-a", validUntil: NOW - 500 };
		expect(applicabilityMatchesTrustedContexts(projectA, [projectA], NOW - 1_000)).toBe(true);
		expect(applicabilityMatchesTrustedContexts(projectA, [projectA], NOW)).toBe(false);
		expect(applicabilityMatchesTrustedContexts({ scope: "global", validUntil: NOW - 500 }, [], NOW)).toBe(
			false,
		);
	});
});

describe("DefaultGraphAwareRetriever applicability", () => {
	it("returns global plus exactly matching scoped baseline nodes", async () => {
		const retriever = new DefaultGraphAwareRetriever();
		const result = await retriever.compare({
			ownerScope: OWNER,
			query: "q",
			baselineNodeIds: ["global", "project-a", "project-b"],
			snapshot: snapshot({
				nodes: [
					{
						id: "global",
						ownerScope: OWNER,
						type: "raw",
						createdAt: NOW,
						visibility: "default",
						applicability: { scope: "global" },
					},
					{
						id: "project-a",
						ownerScope: OWNER,
						type: "raw",
						createdAt: NOW,
						visibility: "default",
						applicability: { scope: "project", key: "project-a" },
					},
					{
						id: "project-b",
						ownerScope: OWNER,
						type: "raw",
						createdAt: NOW,
						visibility: "default",
						applicability: { scope: "project", key: "project-b" },
					},
				],
			}),
			applicabilityContexts: [{ scope: "project", key: "project-a" }],
			visibilityMode: "default",
			asOf: new Date(NOW).toISOString(),
		});

		expect(result.rankedNodeIds).toEqual(["global", "project-a"]);
	});

	it("excludes scoped nodes when the matching trusted context is not active", async () => {
		const retriever = new DefaultGraphAwareRetriever();
		const result = await retriever.compare({
			ownerScope: OWNER,
			query: "q",
			baselineNodeIds: ["project-a"],
			snapshot: snapshot({
				nodes: [
					{
						id: "project-a",
						ownerScope: OWNER,
						type: "raw",
						createdAt: NOW,
						visibility: "default",
						applicability: { scope: "project", key: "project-a" },
					},
				],
			}),
			applicabilityContexts: [{ scope: "project", key: "project-a", validUntil: NOW - 1 }],
			visibilityMode: "default",
			asOf: new Date(NOW).toISOString(),
		});

		expect(result.rankedNodeIds).toEqual([]);
	});

	it("does not expand clusters from a different applicability context", async () => {
		const retriever = new DefaultGraphAwareRetriever();
		const result = await retriever.compare({
			ownerScope: OWNER,
			query: "q",
			baselineNodeIds: ["n1"],
			snapshot: snapshot({
				nodes: [{ id: "n1", ownerScope: OWNER, type: "raw", createdAt: NOW, visibility: "default" }],
				clusters: [
					{
						clusterId: "project-b-cluster",
						ownerScope: OWNER,
						nodeIds: ["n1"],
						lifecycleStatus: "active",
						updatedAt: NOW,
						reasonCodes: [],
						applicability: { scope: "project", key: "project-b" },
					},
				],
			}),
			applicabilityContexts: [{ scope: "project", key: "project-a" }],
			visibilityMode: "default",
			asOf: new Date(NOW).toISOString(),
		});

		expect(result.rankedNodeIds).toEqual(["n1"]);
		expect(result.expandedClusterIds).toEqual([]);
	});
});

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

	it("evaluates applicability at an explicitly requested asOf instant", () => {
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
						applicability: { scope: "project", key: "project-a", validFrom: NOW + 100 },
					},
				],
			}),
			visibilityMode: "default",
			applicabilityContexts: [{ scope: "project", key: "project-a" }],
			asOf: new Date(NOW + 200).toISOString(),
		});

		expect(result.rankedNodeIds).toEqual(["n1"]);
		expect(result.withheldBaselineNodes).toEqual([]);
	});
});
