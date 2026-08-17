import { describe, expect, it } from "vitest";

import {
	type BuildMemorySemanticRetrievalMergedResultsInput,
	type MemorySemanticRetrievalCandidate,
	type MemorySemanticRetrievalDraft,
	type MemorySemanticRetrievalMergedResultSet,
	type MemorySemanticRetrievalPlanningResult,
	type MemorySemanticRetrievalSourceResult,
	buildMemorySemanticRetrievalComparisonReport,
	buildMemorySemanticRetrievalDryRunReport,
	buildMemorySemanticRetrievalEvalScenarioReport,
	buildMemorySemanticRetrievalMergedResults,
	buildMemorySemanticRetrievalPlan,
	resolveMemorySemanticRetrievalConfig,
} from "./retrieval";

const NOW = 1_700_000_000_000;

function draft(overrides: Partial<MemorySemanticRetrievalDraft> = {}): MemorySemanticRetrievalDraft {
	return {
		draftId: "d1",
		type: "summary",
		content: "content",
		sourceRecordIds: ["r1"],
		confidence: 0.9,
		...overrides,
	};
}

function candidate(
	overrides: Partial<MemorySemanticRetrievalCandidate> = {},
): MemorySemanticRetrievalCandidate {
	return {
		draftId: "d1",
		type: "summary",
		content: "content",
		sourceRecordIds: ["r1"],
		confidence: 0.9,
		queryRelevance: 0.8,
		draftStatus: "active",
		status: "eligible",
		reasonCodes: [],
		...overrides,
	};
}

function source(
	overrides: Partial<MemorySemanticRetrievalSourceResult> = {},
): MemorySemanticRetrievalSourceResult {
	return {
		recordId: "r1",
		content: "source content",
		score: 0.7,
		reasonCodes: [],
		...overrides,
	};
}

function plan(
	overrides: Partial<MemorySemanticRetrievalPlanningResult> = {},
): MemorySemanticRetrievalPlanningResult {
	return {
		query: "q",
		candidates: [candidate()],
		fallbackRecordIds: ["r1"],
		...overrides,
	};
}

function merged(
	overrides: Partial<BuildMemorySemanticRetrievalMergedResultsInput> = {},
): MemorySemanticRetrievalMergedResultSet {
	return buildMemorySemanticRetrievalMergedResults({
		plan: plan(),
		config: resolveMemorySemanticRetrievalConfig({ enabled: true }),
		...overrides,
	});
}

describe("resolveMemorySemanticRetrievalConfig", () => {
	it("disables by default", () => {
		const config = resolveMemorySemanticRetrievalConfig();
		expect(config.enabled).toBe(false);
		expect(config.status).toBe("disabled");
		expect(config.reasonCodes).toContain("semantic_retrieval_disabled");
	});

	it("enables when requested", () => {
		const config = resolveMemorySemanticRetrievalConfig({ enabled: true });
		expect(config.enabled).toBe(true);
		expect(config.status).toBe("enabled");
		expect(config.reasonCodes).toContain("semantic_retrieval_enabled");
	});

	it("clamps minConfidence to [0,1]", () => {
		const low = resolveMemorySemanticRetrievalConfig({ minConfidence: -1 });
		const high = resolveMemorySemanticRetrievalConfig({ minConfidence: 2 });
		expect(low.minConfidence).toBe(0);
		expect(high.minConfidence).toBe(1);
	});

	it("floors maxCandidates to non-negative integer", () => {
		const config = resolveMemorySemanticRetrievalConfig({ maxCandidates: 3.7 });
		expect(config.maxCandidates).toBe(3);
	});

	it("treats infinite maxCandidates as undefined", () => {
		const config = resolveMemorySemanticRetrievalConfig({ maxCandidates: Number.POSITIVE_INFINITY });
		expect(config.maxCandidates).toBeUndefined();
	});

	it("preserves custom reason codes", () => {
		const config = resolveMemorySemanticRetrievalConfig({ reasonCodes: ["custom"] });
		expect(config.reasonCodes).toContain("custom");
	});

	it("copies metadata", () => {
		const config = resolveMemorySemanticRetrievalConfig({ metadata: { key: "value" } });
		expect(config.metadata).toEqual({ key: "value" });
	});
});

describe("buildMemorySemanticRetrievalPlan", () => {
	it("returns empty plan with no drafts", () => {
		const result = buildMemorySemanticRetrievalPlan({ query: "q", drafts: [], now: NOW });
		expect(result.candidates).toHaveLength(0);
		expect(result.fallbackRecordIds).toHaveLength(0);
	});

	it("produces candidates for drafts above confidence", () => {
		const result = buildMemorySemanticRetrievalPlan({
			query: "q",
			drafts: [draft({ confidence: 0.9 })],
			now: NOW,
			minConfidence: 0.5,
		});
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0].status).toBe("eligible");
	});

	it("suppresses low-confidence candidates", () => {
		const result = buildMemorySemanticRetrievalPlan({
			query: "q",
			drafts: [draft({ confidence: 0.3 })],
			now: NOW,
			minConfidence: 0.5,
		});
		expect(result.candidates[0].status).toBe("suppressed");
		expect(result.candidates[0].reasonCodes).toContain("low_confidence");
	});

	it("suppresses contested candidates unless allowed", () => {
		const result = buildMemorySemanticRetrievalPlan({
			query: "q",
			drafts: [draft({ status: "contested" })],
			now: NOW,
			allowContested: false,
		});
		expect(result.candidates[0].status).toBe("suppressed");
		expect(result.candidates[0].reasonCodes).toContain("contested_memory");
	});

	it("limits candidates to maxCandidates", () => {
		const result = buildMemorySemanticRetrievalPlan({
			query: "q",
			drafts: [
				draft({ draftId: "d1", confidence: 0.9 }),
				draft({ draftId: "d2", confidence: 0.8 }),
				draft({ draftId: "d3", confidence: 0.7 }),
			],
			now: NOW,
			maxCandidates: 2,
		});
		expect(result.candidates.filter((c) => c.status === "eligible")).toHaveLength(2);
	});
});

describe("buildMemorySemanticRetrievalMergedResults", () => {
	it("includes source results and eligible candidates", () => {
		const result = buildMemorySemanticRetrievalMergedResults({
			plan: plan({
				candidates: [candidate({ draftId: "d1", sourceRecordIds: ["r1"], status: "eligible" })],
				fallbackRecordIds: ["r1"],
			}),
			config: resolveMemorySemanticRetrievalConfig({ enabled: true }),
			sourceResults: [source({ recordId: "r1" })],
		});
		expect(result.enabled).toBe(true);
		expect(result.results).toHaveLength(2);
		expect(result.sourceResults).toHaveLength(1);
		expect(result.semanticResults).toHaveLength(1);
	});

	it("is disabled when config is disabled", () => {
		const result = buildMemorySemanticRetrievalMergedResults({
			plan: plan({ candidates: [candidate()] }),
			config: resolveMemorySemanticRetrievalConfig({ enabled: false }),
			sourceResults: [source()],
		});
		expect(result.enabled).toBe(false);
		expect(result.semanticResults).toHaveLength(0);
		expect(result.results).toHaveLength(1);
	});

	it("reports suppressed drafts", () => {
		const result = buildMemorySemanticRetrievalMergedResults({
			plan: plan({ candidates: [candidate({ status: "suppressed" })] }),
			config: resolveMemorySemanticRetrievalConfig({ enabled: true }),
			sourceResults: [],
		});
		expect(result.suppressedDrafts).toHaveLength(1);
	});
});

describe("buildMemorySemanticRetrievalEvalScenarioReport", () => {
	it("reports exact matches as selected", () => {
		const report = buildMemorySemanticRetrievalEvalScenarioReport({
			scenarioId: "s1",
			merged: merged({
				plan: plan({ candidates: [candidate({ draftId: "d1", status: "eligible" })] }),
			}),
			expectations: { selectedDraftIds: ["d1"] },
		});
		expect(report.selectedPassed).toBe(true);
		expect(report.missingSelectedDraftIds).toEqual([]);
		expect(report.selectedDraftIds).toEqual(["d1"]);
	});

	it("reports missing expectations as recall loss", () => {
		const report = buildMemorySemanticRetrievalEvalScenarioReport({
			scenarioId: "s1",
			merged: merged({
				plan: plan({ candidates: [candidate({ draftId: "d1", status: "eligible" })] }),
			}),
			expectations: { selectedDraftIds: ["d1", "d2"] },
		});
		expect(report.selectedPassed).toBe(false);
		expect(report.missingSelectedDraftIds).toEqual(["d2"]);
	});
});

describe("buildMemorySemanticRetrievalComparisonReport", () => {
	it("reports added semantic draft", () => {
		const baseline = merged({
			plan: plan({ candidates: [], fallbackRecordIds: ["r1"] }),
			sourceResults: [source({ recordId: "r1" })],
		});
		const candidateSet = merged({
			plan: plan({
				candidates: [candidate({ draftId: "d1", sourceRecordIds: ["r1"], status: "eligible" })],
				fallbackRecordIds: ["r1"],
			}),
			sourceResults: [source({ recordId: "r1" })],
		});
		const report = buildMemorySemanticRetrievalComparisonReport({
			baseline,
			candidate: candidateSet,
		});
		expect(report.addedSemanticDrafts.map((d) => d.draftId)).toEqual(["d1"]);
		expect(report.summary.addedSemanticDraftCount).toBe(1);
	});

	it("reports retained fallback records", () => {
		const baseline = merged({
			plan: plan({ candidates: [], fallbackRecordIds: ["r1", "r2"] }),
			sourceResults: [source({ recordId: "r1" }), source({ recordId: "r2" })],
		});
		const candidateSet = merged({
			plan: plan({
				candidates: [candidate({ draftId: "d1", sourceRecordIds: ["r1"], status: "eligible" })],
				fallbackRecordIds: ["r1"],
			}),
			sourceResults: [source({ recordId: "r1" })],
		});
		const report = buildMemorySemanticRetrievalComparisonReport({
			baseline,
			candidate: candidateSet,
		});
		expect(report.retainedFallbackRecordIds).toEqual(["r1"]);
		expect(report.summary.retainedFallbackRecordCount).toBe(1);
	});
});

describe("buildMemorySemanticRetrievalDryRunReport", () => {
	it("wraps plan with reason codes", () => {
		const report = buildMemorySemanticRetrievalDryRunReport({
			plan: plan({ candidates: [candidate({ draftId: "d1", status: "eligible" })] }),
		});
		expect(report.query).toBe("q");
		expect(report.draftCandidateIds).toEqual(["d1"]);
		expect(report.summary.addedDraftCount).toBe(1);
		expect(report.reasonCodes).toContain("source_trace_fallback");
	});
});
