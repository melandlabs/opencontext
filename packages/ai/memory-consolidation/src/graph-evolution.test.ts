import { describe, expect, it } from "vitest";

import type { MemoryGraphClusterSnapshot, MemoryGraphEdge } from "./graph-contracts";
import { applicabilityEquivalent, buildMemoryGraphCompetitionComponents } from "./graph-evolution";

const OWNER = { userId: "u1" };
const NOW = 1_700_000_000_000;

function cluster(overrides: Partial<MemoryGraphClusterSnapshot> = {}): MemoryGraphClusterSnapshot {
	return {
		clusterId: "c1",
		ownerScope: OWNER,
		nodeIds: ["n1"],
		lifecycleStatus: "active",
		updatedAt: NOW,
		reasonCodes: [],
		...overrides,
	};
}

function edge(overrides: Partial<MemoryGraphEdge> = {}): MemoryGraphEdge {
	return {
		id: "e1",
		ownerScope: OWNER,
		fromNodeId: "n1",
		toNodeId: "n2",
		kind: "compete",
		weight: 0.8,
		evidenceNodeIds: [],
		reasonCodes: [],
		createdAt: NOW,
		...overrides,
	};
}

describe("applicabilityEquivalent", () => {
	it("treats undefined and global as equivalent", () => {
		expect(applicabilityEquivalent(undefined, { scope: "global" })).toBe(true);
		expect(applicabilityEquivalent({ scope: "global" }, undefined)).toBe(true);
	});

	it("matches same scope and key", () => {
		expect(applicabilityEquivalent({ scope: "task", key: "t1" }, { scope: "task", key: "t1" })).toBe(true);
	});

	it("differs on scope or key", () => {
		expect(applicabilityEquivalent({ scope: "task", key: "t1" }, { scope: "task", key: "t2" })).toBe(false);
		expect(applicabilityEquivalent({ scope: "task", key: "t1" }, { scope: "project", key: "t1" })).toBe(
			false,
		);
	});

	it("differs on validity window", () => {
		expect(
			applicabilityEquivalent(
				{ scope: "task", key: "t1", validFrom: 100 },
				{ scope: "task", key: "t1", validFrom: 200 },
			),
		).toBe(false);
	});
});

describe("buildMemoryGraphCompetitionComponents", () => {
	it("returns empty array with no competing edges", () => {
		const components = buildMemoryGraphCompetitionComponents({
			ownerScope: OWNER,
			clusters: [cluster({ clusterId: "c1" }), cluster({ clusterId: "c2", nodeIds: ["n2"] })],
			edges: [],
		});
		expect(components).toHaveLength(0);
	});

	it("groups clusters linked by compete edges", () => {
		const components = buildMemoryGraphCompetitionComponents({
			ownerScope: OWNER,
			clusters: [
				cluster({ clusterId: "c1", nodeIds: ["n1"] }),
				cluster({ clusterId: "c2", nodeIds: ["n2"] }),
				cluster({ clusterId: "c3", nodeIds: ["n3"] }),
			],
			edges: [
				edge({ fromNodeId: "n1", toNodeId: "n2" }),
				edge({ id: "e2", fromNodeId: "n2", toNodeId: "n3" }),
			],
		});
		expect(components).toHaveLength(1);
		expect(components[0].clusters.map((c) => c.clusterId).sort()).toEqual(["c1", "c2", "c3"]);
	});

	it("ignores edges with wrong owner scope", () => {
		const components = buildMemoryGraphCompetitionComponents({
			ownerScope: OWNER,
			clusters: [
				cluster({ clusterId: "c1", nodeIds: ["n1"] }),
				cluster({ clusterId: "c2", nodeIds: ["n2"] }),
			],
			edges: [edge({ fromNodeId: "n1", toNodeId: "n2", ownerScope: { userId: "u2" } })],
		});
		expect(components).toHaveLength(0);
	});

	it("ignores non-compete edges", () => {
		const components = buildMemoryGraphCompetitionComponents({
			ownerScope: OWNER,
			clusters: [
				cluster({ clusterId: "c1", nodeIds: ["n1"] }),
				cluster({ clusterId: "c2", nodeIds: ["n2"] }),
			],
			edges: [edge({ fromNodeId: "n1", toNodeId: "n2", kind: "support" })],
		});
		expect(components).toHaveLength(0);
	});

	it("ignores zero-weight or inactive edges", () => {
		const components = buildMemoryGraphCompetitionComponents({
			ownerScope: OWNER,
			clusters: [
				cluster({ clusterId: "c1", nodeIds: ["n1"] }),
				cluster({ clusterId: "c2", nodeIds: ["n2"] }),
			],
			edges: [
				edge({ fromNodeId: "n1", toNodeId: "n2", weight: 0 }),
				edge({ id: "e2", fromNodeId: "n1", toNodeId: "n2", metadata: { inactive: true } }),
			],
		});
		expect(components).toHaveLength(0);
	});

	it("separates disconnected components", () => {
		const components = buildMemoryGraphCompetitionComponents({
			ownerScope: OWNER,
			clusters: [
				cluster({ clusterId: "c1", nodeIds: ["n1"] }),
				cluster({ clusterId: "c2", nodeIds: ["n2"] }),
				cluster({ clusterId: "c3", nodeIds: ["n3"] }),
				cluster({ clusterId: "c4", nodeIds: ["n4"] }),
			],
			edges: [
				edge({ fromNodeId: "n1", toNodeId: "n2" }),
				edge({ id: "e2", fromNodeId: "n3", toNodeId: "n4" }),
			],
		});
		expect(components).toHaveLength(2);
	});

	it("requires applicability equivalence between competing clusters", () => {
		const components = buildMemoryGraphCompetitionComponents({
			ownerScope: OWNER,
			clusters: [
				cluster({ clusterId: "c1", nodeIds: ["n1"], applicability: { scope: "task", key: "t1" } }),
				cluster({ clusterId: "c2", nodeIds: ["n2"], applicability: { scope: "task", key: "t2" } }),
			],
			edges: [edge({ fromNodeId: "n1", toNodeId: "n2" })],
		});
		expect(components).toHaveLength(0);
	});

	it("ignores self-cluster competition edges", () => {
		const components = buildMemoryGraphCompetitionComponents({
			ownerScope: OWNER,
			clusters: [cluster({ clusterId: "c1", nodeIds: ["n1", "n2"] })],
			edges: [edge({ fromNodeId: "n1", toNodeId: "n2" })],
		});
		expect(components).toHaveLength(0);
	});
});
