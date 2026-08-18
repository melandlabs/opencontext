/**
 * Tutorial: insight filtering, focus classification, and EventRank scoring.
 *
 * This example demonstrates the public surface of `@melandlabs/insights`:
 *
 *   1. `insightMatchesFilter` — test whether a single insight matches a
 *      structured filter expression (AND/OR/NOT + keyword, importance, etc.).
 *   2. `filterInsights` — filter a list of insights using the same expressions.
 *   3. `classifyFocusInsight` — turn importance/urgency/mention/action flags
 *      into a focus category such as "immediate" or "high-priority".
 *   4. `calculateBaseScore` — compute an inherent priority score from timing,
 *      tasks, importance and urgency.
 *   5. `sortInsightsByEventRank` — combine EventRank graph propagation with
 *      actionability categories to produce a sorted insight list.
 *
 * The demo uses tiny mock insight objects and asserts on the return values so
 * it exercises the real library code without needing a database or API key.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/32-insights-example.ts
 */

import {
	type InsightBase,
	type InsightFilter,
	calculateBaseScore,
	classifyFocusInsight,
	filterInsights,
	insightMatchesFilter,
	sortInsightsByEventRank,
} from "@melandlabs/insights";
import { runIfMain } from "../_helpers.ts";

function makeInsight(overrides: Partial<InsightBase> & { id: string; title: string }): InsightBase {
	const now = Date.now();
	return {
		id: overrides.id,
		title: overrides.title,
		description: overrides.description ?? "Mock insight for tutorial",
		importance: overrides.importance ?? "medium",
		urgency: overrides.urgency ?? "medium",
		platform: overrides.platform ?? "email",
		account: overrides.account ?? null,
		groups: overrides.groups ?? null,
		people: overrides.people ?? null,
		time: overrides.time ?? now,
		details: overrides.details ?? null,
		timeline: overrides.timeline ?? null,
		taskLabel: overrides.taskLabel ?? "",
		categories: overrides.categories ?? null,
		topKeywords: overrides.topKeywords ?? null,
		isUnreplied: overrides.isUnreplied ?? null,
		myTasks: overrides.myTasks ?? null,
		waitingForMe: overrides.waitingForMe ?? null,
		waitingForOthers: overrides.waitingForOthers ?? null,
		nextActions: overrides.nextActions ?? null,
		followUps: overrides.followUps ?? null,
		dueDate: overrides.dueDate ?? null,
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
	};
}

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- insightMatchesFilter is callable: ${typeof insightMatchesFilter === "function"}`);
	console.log(`- filterInsights is callable: ${typeof filterInsights === "function"}`);
	console.log(`- classifyFocusInsight is callable: ${typeof classifyFocusInsight === "function"}`);
	console.log(`- calculateBaseScore is callable: ${typeof calculateBaseScore === "function"}`);
	console.log(`- sortInsightsByEventRank is callable: ${typeof sortInsightsByEventRank === "function"}`);

	const insights: InsightBase[] = [
		makeInsight({
			id: "ins-1",
			title: "Q3 review deck due tomorrow",
			description: "Please finalize the Q3 review presentation before Friday.",
			importance: "high",
			urgency: "high",
			platform: "slack",
			people: ["alice"],
			topKeywords: ["q3", "review"],
			myTasks: [{ title: "finalize deck", status: "pending" }],
			dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
		}),
		makeInsight({
			id: "ins-2",
			title: "Lunch with Bob next week",
			description: "Scheduled a casual lunch.",
			importance: "low",
			urgency: "low",
			platform: "email",
			people: ["bob"],
			topKeywords: ["lunch"],
		}),
		makeInsight({
			id: "ins-3",
			title: "Server outage in production",
			description: "Production API returned 503s for 10 minutes.",
			importance: "high",
			urgency: "urgent",
			platform: "email",
			people: ["oncall", "alice"],
			topKeywords: ["outage", "production"],
		}),
	];

	// ---- insightMatchesFilter ----
	console.log("\n--- insightMatchesFilter ---");
	const keywordFilter: InsightFilter = {
		match: "all",
		conditions: [{ kind: "keyword", values: ["production"], match: "any" }],
	};
	const matchesProduction = insightMatchesFilter(insights[2], keywordFilter);
	console.log(`production outage matches keyword filter: ${matchesProduction}`);
	if (!matchesProduction) {
		throw new Error("Expected the production outage insight to match the keyword filter");
	}

	// ---- filterInsights ----
	console.log("\n--- filterInsights ---");
	const urgentFilter: InsightFilter = {
		match: "all",
		conditions: [{ kind: "urgency", values: ["urgent"], match: "any" }],
	};
	const urgent = filterInsights(insights, urgentFilter);
	console.log(`urgent insights: ${urgent.map((i) => i.id).join(", ")}`);
	if (urgent.length !== 1 || urgent[0]?.id !== "ins-3") {
		throw new Error("Expected exactly one urgent insight (ins-3)");
	}

	// ---- classifyFocusInsight ----
	console.log("\n--- classifyFocusInsight ---");
	const urgentCategory = classifyFocusInsight({ urgency: "urgent" });
	const importantCategory = classifyFocusInsight({ importance: "high" });
	const mentionCategory = classifyFocusInsight({ hasMyNickname: true });
	const emptyCategory = classifyFocusInsight({});
	console.log(`urgent -> ${urgentCategory}`);
	console.log(`important -> ${importantCategory}`);
	console.log(`mention -> ${mentionCategory}`);
	console.log(`empty -> ${emptyCategory}`);
	if (urgentCategory !== "immediate") {
		throw new Error("Expected urgent insight to classify as immediate");
	}
	if (importantCategory !== "important-info") {
		throw new Error("Expected important insight to classify as important-info");
	}
	if (mentionCategory !== "follow-up") {
		throw new Error("Expected mention insight to classify as follow-up");
	}
	if (emptyCategory !== null) {
		throw new Error("Expected empty insight to classify as null");
	}

	// ---- calculateBaseScore ----
	console.log("\n--- calculateBaseScore ---");
	const baseScore = calculateBaseScore(insights[0]);
	console.log(`Q3 review base score: ${baseScore}`);
	if (baseScore <= 0) {
		throw new Error("Expected a positive base score for the high-priority Q3 insight");
	}

	// ---- sortInsightsByEventRank ----
	console.log("\n--- sortInsightsByEventRank ---");
	const { sorted, scores, categories } = sortInsightsByEventRank(insights);
	console.log(`sorted order: ${sorted.map((i) => i.id).join(", ")}`);
	console.log(`scores available: ${scores.size === insights.length}`);
	for (const [id, category] of categories) {
		console.log(`- ${id}: ${category}`);
	}
	if (sorted.length !== insights.length) {
		throw new Error("Expected sorted output to contain all insights");
	}
	if (scores.size !== insights.length) {
		throw new Error("Expected a score for every insight");
	}

	console.log("\n[OK] Insights tutorial completed");
}

export default main;

runIfMain("Insights tutorial", main);
