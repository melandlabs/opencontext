import { describe, expect, it } from "vitest";

import {
	type MemoryConsolidationEvalScenarioResult,
	calculateMemoryConsolidationEvalMetrics,
} from "./evaluation";

describe("calculateMemoryConsolidationEvalMetrics", () => {
	it("returns zero metrics for empty results", () => {
		const metrics = calculateMemoryConsolidationEvalMetrics([]);
		expect(metrics.scenarioCount).toBe(0);
		expect(metrics.expectedCandidateAccuracy).toBe(0);
		expect(metrics.noisePromotionRate).toBe(0);
		expect(metrics.temporaryOverrideLeakageRate).toBe(0);
		expect(metrics.adaptationAccuracy).toBe(0);
		expect(metrics.projectStateAccuracy).toBe(0);
		expect(metrics.contestedClusterCoverage).toBe(0);
		expect(metrics.decayPrecisionProxy).toBe(0);
	});

	it("computes expected candidate accuracy", () => {
		const results: MemoryConsolidationEvalScenarioResult[] = [
			{ scenarioId: "s1", preservedClusterKeys: ["a"], expectedPreservedClusterKey: "a" },
			{ scenarioId: "s2", preservedClusterKeys: ["b"], expectedPreservedClusterKey: "c" },
		];
		const metrics = calculateMemoryConsolidationEvalMetrics(results);
		expect(metrics.expectedCandidateAccuracy).toBe(0.5);
	});

	it("computes noise promotion rate", () => {
		const results: MemoryConsolidationEvalScenarioResult[] = [
			{
				scenarioId: "s1",
				metricTags: ["noise"],
				preservedClusterKeys: ["noise-cluster"],
				noiseClusterKeys: ["noise-cluster"],
			},
			{
				scenarioId: "s2",
				metricTags: ["noise"],
				preservedClusterKeys: ["real-cluster"],
				noiseClusterKeys: ["noise-cluster"],
			},
		];
		const metrics = calculateMemoryConsolidationEvalMetrics(results);
		expect(metrics.noisePromotionRate).toBe(0.5);
	});

	it("computes temporary override leakage rate", () => {
		const results: MemoryConsolidationEvalScenarioResult[] = [
			{
				scenarioId: "s1",
				metricTags: ["temporary-override"],
				preservedClusterKeys: ["temporary-cluster"],
				temporaryClusterKeys: ["temporary-cluster"],
			},
			{
				scenarioId: "s2",
				metricTags: ["temporary-override"],
				preservedClusterKeys: ["permanent-cluster"],
				temporaryClusterKeys: ["temporary-cluster"],
			},
		];
		const metrics = calculateMemoryConsolidationEvalMetrics(results);
		expect(metrics.temporaryOverrideLeakageRate).toBe(0.5);
	});

	it("computes contested cluster coverage", () => {
		const results: MemoryConsolidationEvalScenarioResult[] = [
			{
				scenarioId: "s1",
				contestedClusterKeys: ["a", "b"],
				expectedContestedClusterKeys: ["a", "b"],
				preservedClusterKeys: [],
			},
			{
				scenarioId: "s2",
				contestedClusterKeys: ["a"],
				expectedContestedClusterKeys: ["a", "b"],
				preservedClusterKeys: [],
			},
		];
		const metrics = calculateMemoryConsolidationEvalMetrics(results);
		expect(metrics.contestedClusterCoverage).toBe(0.5);
	});

	it("computes decay precision proxy", () => {
		const results: MemoryConsolidationEvalScenarioResult[] = [
			{
				scenarioId: "s1",
				decayedClusterKeys: ["a", "b"],
				expectedDecayedClusterKeys: ["a", "b"],
				preservedClusterKeys: [],
			},
			{
				scenarioId: "s2",
				decayedClusterKeys: ["a", "c"],
				expectedDecayedClusterKeys: ["a"],
				preservedClusterKeys: [],
			},
		];
		const metrics = calculateMemoryConsolidationEvalMetrics(results);
		expect(metrics.decayPrecisionProxy).toBe(0.75);
	});

	it("returns 0 when no scenario has decay information", () => {
		const results: MemoryConsolidationEvalScenarioResult[] = [
			{ scenarioId: "s1", preservedClusterKeys: ["a"] },
		];
		const metrics = calculateMemoryConsolidationEvalMetrics(results);
		expect(metrics.decayPrecisionProxy).toBe(0);
	});

	it("returns 1 when actual decay matches expected decay exactly", () => {
		const results: MemoryConsolidationEvalScenarioResult[] = [
			{
				scenarioId: "s1",
				preservedClusterKeys: [],
				decayedClusterKeys: ["a", "b"],
				expectedDecayedClusterKeys: ["a", "b"],
			},
		];
		const metrics = calculateMemoryConsolidationEvalMetrics(results);
		expect(metrics.decayPrecisionProxy).toBe(1);
	});

	it("computes adaptation and project state accuracy", () => {
		const results: MemoryConsolidationEvalScenarioResult[] = [
			{
				scenarioId: "s1",
				metricTags: ["adaptation", "project-state"],
				preservedClusterKeys: ["a"],
				expectedPreservedClusterKey: "a",
			},
			{
				scenarioId: "s2",
				metricTags: ["adaptation"],
				preservedClusterKeys: ["b"],
				expectedPreservedClusterKey: "c",
			},
		];
		const metrics = calculateMemoryConsolidationEvalMetrics(results);
		expect(metrics.adaptationAccuracy).toBe(0.5);
		expect(metrics.projectStateAccuracy).toBe(1);
	});
});
