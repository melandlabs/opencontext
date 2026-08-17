import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONTENT_TAGS,
	DEFAULT_CATEGORIES,
	EMAIL_TASK_LABEL,
	INSIGHT_TYPE_TAGS,
	MAX_EMAIL_INSIGHTS,
	calculateBaseScore,
	calculateEventRank,
	classifyFocusInsight,
	dedupeOptions,
	deduplicateInsights,
	extractInsightTags,
	filterEmptyInsights,
	filterInsights,
	formatTimingError,
	getFilterFieldDescription,
	getFilterFieldLabel,
	getFocusCategoryMeta,
	getInsightPlatforms,
	getSupportedFilterFields,
	hasOverdueTasks,
	hasTaskDueToday,
	insightHasContent,
	insightIsImport,
	insightIsImportOrUrgent,
	insightIsUrgent,
	insightMatchesFilter,
	insightMatchesFilterDefinition,
	isFieldSupportedByAllPlatforms,
	isFilterBinaryExpr,
	isFilterDefinition,
	isFilterNotExpr,
	normalizeBasicOption,
	normalizeImportanceOption,
	normalizePlatformKey,
	normalizePlatformOption,
	normalizeUrgencyOption,
	resolveAgentLanguage,
	sanitizeColorToken,
	sanitizeFilterSlug,
	shouldLogTimingEvent,
	sortInsightsByEventRank,
	toInsightFilterResponse,
} from "./index";
import type { InsightBase } from "./types";

function makeInsight(overrides: Partial<InsightBase> = {}): InsightBase {
	return {
		id: "insight-1",
		title: "Test Insight",
		description: "This is a meaningful description that has more than ten characters.",
		importance: "medium",
		urgency: "not urgent",
		platform: "slack",
		account: "user@example.com",
		groups: ["general"],
		people: ["Alice"],
		time: new Date("2024-01-15T10:00:00Z").getTime(),
		details: null,
		timeline: null,
		taskLabel: "follow_up",
		categories: ["Meetings"],
		topKeywords: ["test"],
		myTasks: null,
		waitingForMe: null,
		waitingForOthers: null,
		nextActions: null,
		followUps: null,
		...overrides,
	};
}

describe("option normalizers", () => {
	describe("normalizeImportanceOption", () => {
		it("returns null for empty values", () => {
			expect(normalizeImportanceOption("")).toBeNull();
			expect(normalizeImportanceOption(null)).toBeNull();
			expect(normalizeImportanceOption(undefined)).toBeNull();
		});

		it("normalizes known importance aliases", () => {
			expect(normalizeImportanceOption("high")).toEqual({
				key: "high",
				label: "High",
				priorities: ["High", "Important"],
			});
			expect(normalizeImportanceOption("important")).toEqual({
				key: "high",
				label: "Important",
				priorities: ["High", "Important"],
			});
			expect(normalizeImportanceOption("not important")).toEqual({
				key: "low",
				label: "Not important",
				priorities: ["Low", "Not Important"],
			});
		});

		it("falls back to lower-cased key for unknown values", () => {
			expect(normalizeImportanceOption("critical")).toEqual({
				key: "critical",
				label: "Critical",
			});
		});
	});

	describe("normalizeUrgencyOption", () => {
		it("returns null for empty values", () => {
			expect(normalizeUrgencyOption("")).toBeNull();
			expect(normalizeUrgencyOption(null)).toBeNull();
			expect(normalizeUrgencyOption(undefined)).toBeNull();
		});

		it("normalizes known urgency aliases", () => {
			expect(normalizeUrgencyOption("urgent")).toEqual({
				key: "immediate",
				label: "Urgent",
				priorities: ["Immediate", "As soon as possible"],
			});
			expect(normalizeUrgencyOption("24h")).toEqual({
				key: "within_24h",
				label: "24h",
				priorities: ["Within 24 hours"],
			});
			expect(normalizeUrgencyOption("not urgent")).toEqual({
				key: "not_urgent",
				label: "Not urgent",
				priorities: ["Not urgent"],
			});
		});
	});

	describe("normalizePlatformOption", () => {
		it("returns null for empty values", () => {
			expect(normalizePlatformOption("")).toBeNull();
			expect(normalizePlatformOption(null)).toBeNull();
		});

		it("normalizes known platforms using preferred labels", () => {
			expect(normalizePlatformOption("gmail")).toEqual({
				key: "gmail",
				label: "Gmail",
				priorities: ["Gmail", "Gmail", "gmail"],
			});
			expect(normalizePlatformOption("Google Calendar")).toEqual({
				key: "googlecalendar",
				label: "Google Calendar",
				priorities: ["Google Calendar", "Google Calendar", "Google Calendar"],
			});
		});

		it("humanizes unknown platform slugs", () => {
			expect(normalizePlatformOption("my_custom-platform")).toEqual({
				key: "mycustomplatform",
				label: "My Custom Platform",
				priorities: ["My Custom Platform", "my_custom-platform"],
			});
		});
	});

	describe("normalizeBasicOption", () => {
		it("returns null for empty values", () => {
			expect(normalizeBasicOption("")).toBeNull();
			expect(normalizeBasicOption(null)).toBeNull();
		});

		it("returns lower-case key with original label", () => {
			expect(normalizeBasicOption("Hello World")).toEqual({
				key: "hello world",
				label: "Hello World",
			});
		});
	});

	describe("dedupeOptions", () => {
		it("deduplicates options by normalized key and picks preferred label", () => {
			const result = dedupeOptions(["high", "High", "important", "low"], normalizeImportanceOption);
			expect(result).toEqual(["High", "Low"]);
		});

		it("filters out empty values", () => {
			expect(dedupeOptions(["", null, "slack", undefined], normalizePlatformOption)).toEqual(["Slack"]);
		});
	});

	describe("normalizePlatformKey", () => {
		it("returns the normalized platform key", () => {
			expect(normalizePlatformKey("Google Calendar")).toBe("googlecalendar");
		});

		it("returns empty string for invalid values", () => {
			expect(normalizePlatformKey("")).toBe("");
		});
	});
});

describe("focus classifier", () => {
	describe("insightIsImport", () => {
		it("recognizes high importance values", () => {
			expect(insightIsImport({ importance: "high" })).toBe(true);
			expect(insightIsImport({ importance: "High" })).toBe(true);
			expect(insightIsImport({ importance: "important" })).toBe(true);
			expect(insightIsImport({ importance: "low" })).toBe(false);
		});
	});

	describe("insightIsUrgent", () => {
		it("recognizes urgent values", () => {
			expect(insightIsUrgent({ urgency: "urgent" })).toBe(true);
			expect(insightIsUrgent({ urgency: "ASAP" })).toBe(true);
			expect(insightIsUrgent({ urgency: "as soon as possible" })).toBe(true);
			expect(insightIsUrgent({ urgency: "not urgent" })).toBe(false);
		});
	});

	describe("insightIsImportOrUrgent", () => {
		it("returns true if either flag is set", () => {
			expect(insightIsImportOrUrgent({ importance: "high" })).toBe(true);
			expect(insightIsImportOrUrgent({ urgency: "urgent" })).toBe(true);
			expect(insightIsImportOrUrgent({})).toBe(false);
		});
	});

	describe("extractInsightTags", () => {
		it("returns tags based on insight properties", () => {
			expect(extractInsightTags({ importance: "high", hasActions: true })).toEqual([
				"important",
				"action-items",
			]);
			expect(extractInsightTags({ urgency: "urgent", hasMyNickname: true })).toEqual([
				"urgent",
				"mentions-me",
			]);
		});

		it("returns empty array when no tags match", () => {
			expect(extractInsightTags({})).toEqual([]);
		});
	});

	describe("classifyFocusInsight", () => {
		it("classifies urgent insights as immediate", () => {
			expect(classifyFocusInsight({ urgency: "urgent" })).toBe("immediate");
		});

		it("classifies insights with incomplete myTasks as high-priority", () => {
			expect(
				classifyFocusInsight({
					myTasks: [{ status: "pending" }],
				}),
			).toBe("high-priority");
		});

		it("does not classify completed-only tasks as high-priority", () => {
			expect(
				classifyFocusInsight({
					myTasks: [{ status: "completed" }],
					importance: "high",
				}),
			).toBe("important-info");
		});

		it("classifies important insights without incomplete tasks as important-info", () => {
			expect(classifyFocusInsight({ importance: "high" })).toBe("important-info");
		});

		it("classifies mentions-me insights as follow-up", () => {
			expect(classifyFocusInsight({ hasMyNickname: true })).toBe("follow-up");
		});

		it("returns null when no rule matches", () => {
			expect(classifyFocusInsight({})).toBeNull();
		});
	});

	describe("getFocusCategoryMeta", () => {
		it("returns metadata for known categories", () => {
			expect(getFocusCategoryMeta("immediate")?.category).toBe("immediate");
			expect(getFocusCategoryMeta("high-priority")?.icon).toBe("⚡");
		});

		it("returns null for null category", () => {
			expect(getFocusCategoryMeta(null)).toBeNull();
		});
	});

	describe("getInsightPlatforms", () => {
		it("collects unique platforms from insight and details", () => {
			const platforms = getInsightPlatforms({
				platform: "slack",
				account: "user@example.com",
				details: [{ platform: "gmail" }, { platform: "slack" }],
			});
			expect(platforms).toEqual([
				{ platform: "slack", label: "slack" },
				{ platform: "gmail", label: "gmail" },
			]);
		});

		it("returns empty array when platform and details are empty", () => {
			expect(getInsightPlatforms({ platform: null, account: null, details: null })).toEqual([]);
		});
	});
});

describe("insight-utils", () => {
	describe("insightHasContent", () => {
		it("returns true for insights with meaningful description", () => {
			expect(insightHasContent(makeInsight())).toBe(true);
		});

		it("returns false for empty insights", () => {
			expect(
				insightHasContent(
					makeInsight({
						description: "short",
						details: null,
						timeline: null,
						nextActions: null,
						followUps: null,
						myTasks: null,
						waitingForMe: null,
						waitingForOthers: null,
					}),
				),
			).toBe(false);
		});

		it("returns true for insights with active tasks", () => {
			expect(
				insightHasContent(
					makeInsight({
						description: "short",
						myTasks: [{ status: "pending" }],
					}),
				),
			).toBe(true);
		});

		it("returns true for insights with details", () => {
			expect(
				insightHasContent(
					makeInsight({
						description: "short",
						details: [{ content: "detail" }],
					}),
				),
			).toBe(true);
		});
	});

	describe("filterEmptyInsights", () => {
		it("returns empty array for empty input", () => {
			expect(filterEmptyInsights([])).toEqual([]);
			expect(filterEmptyInsights(undefined as unknown as InsightBase[])).toEqual([]);
		});

		it("filters out empty insights", () => {
			const empty = makeInsight({ description: "short" });
			const full = makeInsight();
			expect(filterEmptyInsights([empty, full])).toHaveLength(1);
		});
	});

	describe("hasTaskDueToday", () => {
		const today = new Date("2024-06-15T00:00:00Z");

		it("returns true when a task is due today", () => {
			expect(
				hasTaskDueToday(
					makeInsight({
						myTasks: [{ status: "pending", deadline: "2024-06-15T12:00:00Z" }],
					}),
					today,
				),
			).toBe(true);
		});

		it("returns false when tasks are completed", () => {
			expect(
				hasTaskDueToday(
					makeInsight({
						myTasks: [{ status: "completed", deadline: "2024-06-15T12:00:00Z" }],
					}),
					today,
				),
			).toBe(false);
		});

		it("returns false when deadline is not today", () => {
			expect(
				hasTaskDueToday(
					makeInsight({
						myTasks: [{ status: "pending", deadline: "2024-06-16T12:00:00Z" }],
					}),
					today,
				),
			).toBe(false);
		});
	});

	describe("hasOverdueTasks", () => {
		const today = new Date("2024-06-15T00:00:00Z");

		it("returns true for overdue incomplete tasks", () => {
			expect(
				hasOverdueTasks(
					makeInsight({
						myTasks: [{ status: "pending", deadline: "2024-06-14T12:00:00Z" }],
					}),
					today,
				),
			).toBe(true);
		});

		it("returns false for future deadlines", () => {
			expect(
				hasOverdueTasks(
					makeInsight({
						myTasks: [{ status: "pending", deadline: "2024-06-16T12:00:00Z" }],
					}),
					today,
				),
			).toBe(false);
		});
	});

	describe("deduplicateInsights", () => {
		it("deduplicates by title by default", () => {
			const a = makeInsight({ id: "a", title: "Duplicate" });
			const b = makeInsight({ id: "b", title: "Duplicate" });
			const c = makeInsight({ id: "c", title: "Unique" });
			expect(deduplicateInsights([a, b, c])).toHaveLength(2);
		});

		it("deduplicates by custom key field", () => {
			const a = makeInsight({ id: "a", title: "One", account: "acct" });
			const b = makeInsight({ id: "b", title: "Two", account: "acct" });
			expect(deduplicateInsights([a, b], "account")).toHaveLength(1);
		});

		it("returns empty array for non-array input", () => {
			expect(deduplicateInsights(null as unknown as InsightBase[])).toEqual([]);
		});
	});
});

describe("filter-utils", () => {
	describe("isFilterDefinition / isFilterBinaryExpr / isFilterNotExpr", () => {
		const definition = {
			match: "all" as const,
			conditions: [{ kind: "importance" as const, values: ["high"] }],
		};
		const binary = { op: "and" as const, left: definition, right: definition };
		const notExpr = { op: "not" as const, operand: definition };

		it("identifies filter definitions", () => {
			expect(isFilterDefinition(definition)).toBe(true);
			expect(isFilterDefinition(binary)).toBe(false);
		});

		it("identifies binary expressions", () => {
			expect(isFilterBinaryExpr(binary)).toBe(true);
			expect(isFilterBinaryExpr(definition)).toBe(false);
		});

		it("identifies not expressions", () => {
			expect(isFilterNotExpr(notExpr)).toBe(true);
			expect(isFilterNotExpr(binary)).toBe(false);
		});
	});

	describe("insightMatchesFilterDefinition", () => {
		it("matches by importance", () => {
			const insight = makeInsight({ importance: "high" });
			const filter = {
				match: "all" as const,
				conditions: [{ kind: "importance" as const, values: ["high"] }],
			};
			expect(insightMatchesFilterDefinition(insight, filter)).toBe(true);
		});

		it("matches by urgency", () => {
			const insight = makeInsight({ urgency: "urgent" });
			const filter = {
				match: "all" as const,
				conditions: [{ kind: "urgency" as const, values: ["urgent"] }],
			};
			expect(insightMatchesFilterDefinition(insight, filter)).toBe(true);
		});

		it("matches by platform", () => {
			const insight = makeInsight({ platform: "gmail" });
			const filter = {
				match: "all" as const,
				conditions: [{ kind: "platform" as const, values: ["gmail"] }],
			};
			expect(insightMatchesFilterDefinition(insight, filter)).toBe(true);
		});

		it("matches by keyword", () => {
			const insight = makeInsight({ title: "Quarterly planning" });
			const filter = {
				match: "all" as const,
				conditions: [{ kind: "keyword" as const, values: ["planning"], match: "any" as const }],
			};
			expect(insightMatchesFilterDefinition(insight, filter)).toBe(true);
		});

		it("matches by category", () => {
			const insight = makeInsight({ categories: ["Funding"] });
			const filter = {
				match: "all" as const,
				conditions: [{ kind: "category" as const, values: ["funding"] }],
			};
			expect(insightMatchesFilterDefinition(insight, filter)).toBe(true);
		});

		it("matches by people", () => {
			const insight = makeInsight({ people: ["Alice", "Bob"] });
			const filter = {
				match: "all" as const,
				conditions: [
					{ kind: "people" as const, values: ["alice"], match: "any" as const, caseSensitive: false },
				],
			};
			expect(insightMatchesFilterDefinition(insight, filter)).toBe(true);
		});

		it("matches by mentions_me", () => {
			const insight = makeInsight({ people: ["Me"] });
			const filter = { match: "all" as const, conditions: [{ kind: "mentions_me" as const, values: [] }] };
			expect(insightMatchesFilterDefinition(insight, filter, { myNicknames: ["Me"] })).toBe(true);
		});

		it("matches by time_window", () => {
			const now = new Date("2024-06-15T12:00:00Z");
			const insight = makeInsight({ time: "2024-06-15T10:00:00Z" });
			const filter = {
				match: "all" as const,
				conditions: [{ kind: "time_window" as const, withinHours: 24 }],
			};
			expect(insightMatchesFilterDefinition(insight, filter, { now })).toBe(true);
		});

		it("matches by has_tasks", () => {
			const insight = makeInsight({ myTasks: [{ status: "pending" }] });
			const filter = {
				match: "all" as const,
				conditions: [{ kind: "has_tasks" as const, values: ["myTasks" as const] }],
			};
			expect(insightMatchesFilterDefinition(insight, filter)).toBe(true);
		});

		it("respects match all vs any", () => {
			const insight = makeInsight({ importance: "high", urgency: "not urgent" });
			const allFilter = {
				match: "all" as const,
				conditions: [
					{ kind: "importance" as const, values: ["high"] },
					{ kind: "urgency" as const, values: ["urgent"] },
				],
			};
			const anyFilter = {
				match: "any" as const,
				conditions: [
					{ kind: "importance" as const, values: ["high"] },
					{ kind: "urgency" as const, values: ["urgent"] },
				],
			};
			expect(insightMatchesFilterDefinition(insight, allFilter)).toBe(false);
			expect(insightMatchesFilterDefinition(insight, anyFilter)).toBe(true);
		});
	});

	describe("insightMatchesFilter", () => {
		const definition = {
			match: "all" as const,
			conditions: [{ kind: "importance" as const, values: ["high"] }],
		};

		it("evaluates definitions directly", () => {
			expect(insightMatchesFilter(makeInsight({ importance: "high" }), definition)).toBe(true);
			expect(insightMatchesFilter(makeInsight({ importance: "low" }), definition)).toBe(false);
		});

		it("evaluates not expressions", () => {
			const notExpr = { op: "not" as const, operand: definition };
			expect(insightMatchesFilter(makeInsight({ importance: "low" }), notExpr)).toBe(true);
			expect(insightMatchesFilter(makeInsight({ importance: "high" }), notExpr)).toBe(false);
		});

		it("evaluates binary expressions", () => {
			const left = { match: "all" as const, conditions: [{ kind: "importance" as const, values: ["high"] }] };
			const right = { match: "all" as const, conditions: [{ kind: "urgency" as const, values: ["urgent"] }] };
			const andExpr = { op: "and" as const, left, right };
			const orExpr = { op: "or" as const, left, right };

			expect(insightMatchesFilter(makeInsight({ importance: "high", urgency: "urgent" }), andExpr)).toBe(
				true,
			);
			expect(insightMatchesFilter(makeInsight({ importance: "high", urgency: "not urgent" }), andExpr)).toBe(
				false,
			);
			expect(insightMatchesFilter(makeInsight({ importance: "high", urgency: "not urgent" }), orExpr)).toBe(
				true,
			);
		});
	});

	describe("filterInsights", () => {
		it("filters insights with nested expressions", () => {
			const a = makeInsight({ id: "a", importance: "high" });
			const b = makeInsight({ id: "b", importance: "low" });
			const filter = {
				op: "not" as const,
				operand: {
					match: "all" as const,
					conditions: [{ kind: "importance" as const, values: ["high"] }],
				},
			};
			const result = filterInsights([a, b], filter);
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("b");
		});
	});

	describe("toInsightFilterResponse", () => {
		it("maps a record to a filter response shape", () => {
			const record = {
				id: "f1",
				userId: "u1",
				label: "My Filter",
				slug: "my-filter",
				sortOrder: 1,
				isPinned: false,
				isArchived: false,
				definition: { match: "all", conditions: [] },
				createdAt: new Date("2024-01-01T00:00:00Z"),
				updatedAt: new Date("2024-01-02T00:00:00Z"),
			};
			const response = toInsightFilterResponse(record);
			expect(response.id).toBe("f1");
			expect(response.description).toBeNull();
			expect(response.createdAt).toBe("2024-01-01T00:00:00.000Z");
			expect(response.updatedAt).toBe("2024-01-02T00:00:00.000Z");
		});
	});
});

describe("event-rank", () => {
	const fixedNow = new Date("2024-06-15T12:00:00Z");

	describe("calculateBaseScore", () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(fixedNow);
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("returns a base score for a typical insight", () => {
			const insight = makeInsight({ time: fixedNow.getTime() - 1000 * 60 * 60 });
			const score = calculateBaseScore(insight);
			expect(typeof score).toBe("number");
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(10);
		});

		it("boosts score for high urgency and importance", () => {
			const insight = makeInsight({ urgency: "high", importance: "high" });
			const score = calculateBaseScore(insight);
			expect(score).toBeGreaterThan(calculateBaseScore(makeInsight({ urgency: "low", importance: "low" })));
		});

		it("applies email channel decay", () => {
			const email = makeInsight({ platform: "gmail" });
			const slack = makeInsight({ platform: "slack" });
			expect(calculateBaseScore(email)).toBeLessThan(calculateBaseScore(slack));
		});

		it("can disable channel decay", () => {
			const email = makeInsight({ platform: "gmail" });
			expect(calculateBaseScore(email, { applyChannelDecay: false })).toBeGreaterThan(
				calculateBaseScore(email, { applyChannelDecay: true }),
			);
		});

		it("applies custom multiplier", () => {
			const insight = makeInsight();
			expect(calculateBaseScore(insight, { customMultiplier: 2 })).toBeGreaterThan(
				calculateBaseScore(insight),
			);
		});

		it("caps the score at 10", () => {
			const insight = makeInsight({
				urgency: "high",
				importance: "high",
				myTasks: Array.from({ length: 10 }, () => ({ status: "pending" })),
				waitingForMe: Array.from({ length: 10 }, () => ({ status: "pending" })),
				dueDate: "2024-06-14T00:00:00Z",
			});
			expect(calculateBaseScore(insight)).toBeLessThanOrEqual(10);
		});
	});

	describe("calculateEventRank", () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(fixedNow);
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("returns empty map for empty input", () => {
			expect(calculateEventRank([])).toEqual(new Map());
		});

		it("calculates scores for linked insights", () => {
			const a = makeInsight({ id: "a", people: ["Alice"], topKeywords: ["demo"] });
			const b = makeInsight({ id: "b", people: ["Alice"], topKeywords: ["demo"] });
			const result = calculateEventRank([a, b]);
			expect(result.size).toBe(2);
			expect(result.get("a")?.breakdown.baseScore).toBeGreaterThanOrEqual(0);
		});

		it("uses simplified scoring for large datasets", () => {
			const insights = Array.from({ length: 201 }, (_, i) => makeInsight({ id: String(i) }));
			const result = calculateEventRank(insights);
			expect(result.size).toBe(201);
			const first = result.get("0");
			expect(first?.breakdown.eventRank).toBe(0);
		});
	});

	describe("sortInsightsByEventRank", () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(fixedNow);
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("sorts urgent insights before monitor insights", () => {
			const monitor = makeInsight({ id: "monitor", urgency: "not urgent", importance: "low" });
			const urgent = makeInsight({
				id: "urgent",
				urgency: "high",
				importance: "high",
				myTasks: [{ status: "pending" }],
				dueDate: "2024-06-14T00:00:00Z",
				updatedAt: fixedNow.toISOString(),
			});
			const { sorted, categories } = sortInsightsByEventRank([monitor, urgent]);
			expect(sorted[0].id).toBe("urgent");
			expect(categories.get("urgent")).toBe("urgent");
		});

		it("sorts same category by time descending", () => {
			const older = makeInsight({ id: "older", time: "2024-06-14T10:00:00Z" });
			const newer = makeInsight({ id: "newer", time: "2024-06-15T10:00:00Z" });
			const { sorted } = sortInsightsByEventRank([older, newer]);
			expect(sorted[0].id).toBe("newer");
		});
	});
});

describe("refresh-telemetry", () => {
	describe("formatTimingError", () => {
		it("returns 'unknown' for falsy errors", () => {
			expect(formatTimingError(null)).toBe("unknown");
			expect(formatTimingError(undefined)).toBe("unknown");
		});

		it("formats Error instances", () => {
			expect(formatTimingError(new Error("boom"))).toBe("Error: boom");
		});

		it("formats string errors", () => {
			expect(formatTimingError("boom")).toBe("boom");
		});

		it("truncates long errors", () => {
			const long = "x".repeat(250);
			expect(formatTimingError(long)).toHaveLength(200);
		});
	});

	describe("shouldLogTimingEvent", () => {
		it("logs start events only for summary phases", () => {
			expect(shouldLogTimingEvent({ phase: "summary", status: "start", isSummaryPhase: () => true })).toBe(
				true,
			);
			expect(shouldLogTimingEvent({ phase: "detail", status: "start", isSummaryPhase: () => false })).toBe(
				false,
			);
		});

		it("logs all non-start events for summary phases", () => {
			expect(shouldLogTimingEvent({ phase: "summary", status: "success", isSummaryPhase: () => true })).toBe(
				true,
			);
			expect(shouldLogTimingEvent({ phase: "summary", status: "failure", isSummaryPhase: () => true })).toBe(
				true,
			);
		});

		it("logs only failure and skip for non-summary phases", () => {
			expect(shouldLogTimingEvent({ phase: "detail", status: "failure" })).toBe(true);
			expect(shouldLogTimingEvent({ phase: "detail", status: "skip" })).toBe(true);
			expect(shouldLogTimingEvent({ phase: "detail", status: "success" })).toBe(false);
		});
	});
});

describe("filter-schema helpers", () => {
	describe("sanitizeFilterSlug", () => {
		it("trims and lowercases slugs", () => {
			expect(sanitizeFilterSlug("  MyFilter-1  ")).toBe("myfilter-1");
		});
	});

	describe("sanitizeColorToken", () => {
		it("adds a leading hash and uppercases", () => {
			expect(sanitizeColorToken("4f46e5")).toBe("#4F46E5");
			expect(sanitizeColorToken("#abc")).toBe("#ABC");
		});

		it("returns null for empty values", () => {
			expect(sanitizeColorToken("")).toBeNull();
			expect(sanitizeColorToken(null)).toBeNull();
		});
	});
});

describe("platform-filter-config", () => {
	describe("getSupportedFilterFields", () => {
		it("returns all common fields when no platforms are connected", () => {
			expect(getSupportedFilterFields([])).toContain("importance");
			expect(getSupportedFilterFields([])).toContain("keyword");
		});

		it("returns fields supported by connected platforms", () => {
			const fields = getSupportedFilterFields(["gmail"]);
			expect(fields).toContain("keyword");
			expect(fields).not.toContain("groups");
		});
	});

	describe("isFieldSupportedByAllPlatforms", () => {
		it("returns true with no connected platforms", () => {
			expect(isFieldSupportedByAllPlatforms("keyword", [])).toBe(true);
		});

		it("checks support across all connected platforms", () => {
			expect(isFieldSupportedByAllPlatforms("groups", ["slack", "gmail"])).toBe(false);
			expect(isFieldSupportedByAllPlatforms("keyword", ["slack", "gmail"])).toBe(true);
		});
	});

	describe("getFilterFieldLabel", () => {
		it("returns the default label", () => {
			expect(getFilterFieldLabel("keyword")).toBe("Keyword");
		});

		it("uses translator when provided", () => {
			const t = vi.fn((key: string, defaultValue?: string) => `t:${key}:${defaultValue}`);
			expect(getFilterFieldLabel("keyword", t)).toBe("t:insight.filter.field.keyword:Keyword");
		});
	});

	describe("getFilterFieldDescription", () => {
		it("returns the default description", () => {
			expect(getFilterFieldDescription("keyword")).toContain("keyword");
		});
	});
});

describe("resolve-language", () => {
	describe("resolveAgentLanguage", () => {
		it("prefers explicit language over auto", () => {
			expect(resolveAgentLanguage({ language: "en", languageAuto: "zh" })).toBe("en");
		});

		it("falls back to auto language", () => {
			expect(resolveAgentLanguage({ languageAuto: "zh" })).toBe("zh");
		});

		it("returns null when no language is set", () => {
			expect(resolveAgentLanguage({})).toBeNull();
			expect(resolveAgentLanguage(null)).toBeNull();
		});
	});
});

describe("constants", () => {
	it("exports expected constants", () => {
		expect(EMAIL_TASK_LABEL).toBe("gmail_email");
		expect(MAX_EMAIL_INSIGHTS).toBe(200);
		expect(DEFAULT_CATEGORIES).toContain("News");
		expect(INSIGHT_TYPE_TAGS).toContain("Actions");
		expect(CONTENT_TAGS).toContain("Marketing");
	});
});
