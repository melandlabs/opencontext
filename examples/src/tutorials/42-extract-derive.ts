/**
 * Walkthrough for the `distill` + `derive` primitives and the
 * per-hit `signals` field — see the "Extract, Derive, and Per-Hit
 * Signals" section of `docs/tutorials/03-advanced-usage.md`.
 *
 * Three steps, each running in isolation with stub host deps so the
 * walkthrough needs no external API keys:
 *
 *   1. distill       — rule-based entity extractor + in-memory persist
 *   2. derive        — trivial summary deriver + explicit candidateTexts
 *   3. search-signals — wire entitySearch into createUnifiedSearch, assert
 *                       that hits carry signals.channels / signals.entity
 *
 * Run via the examples runner:
 *
 *     cd examples && pnpm test
 */

import type { DerivedFact, EntityEdge } from "@melandlabs/contracts";
import {
	createUnifiedSearch,
	deriveFacts,
	distillRawMessage,
	type DistillWarning,
	type HitSignals,
	type UnifiedSearchDeps,
} from "@melandlabs/opencontext";
import { runIfMain } from "../_helpers.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
	const tag = ok ? "OK  " : "FAIL";
	const suffix = detail ? ` (${detail})` : "";
	console.log(`    [${tag}] ${label}${suffix}`);
	if (!ok) failed += 1;
}

// ─── 1. distill ────────────────────────────────────────────────────────────

async function runDistill() {
	console.log("  distill");

	const persistedEdges: EntityEdge[] = [];
	let persistCalls = 0;

	const deps: Pick<UnifiedSearchDeps, "entityExtractor"> = {
		// Rule-based stub extractor: matches "Luna" and any uppercase word.
		entityExtractor: async (input) => {
			const edges: EntityEdge[] = [];
			if (input.content.toLowerCase().includes("luna")) {
				edges.push({
					label: "Luna",
					kind: "person",
					relation: "mentions",
					sourceMessageId: input.messageId,
					extractedAt: Date.now(),
					confidence: 0.95,
				});
			}
			const proper = input.content.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
			for (const label of new Set(proper)) {
				if (label === "Luna") continue;
				edges.push({
					label,
					kind: "concept",
					relation: "mentions",
					sourceMessageId: input.messageId,
					extractedAt: Date.now(),
					confidence: 0.5,
				});
			}
			return edges;
		},
	};

	const result = await distillRawMessage(deps, {
		userId: "u1",
		messageId: "m1",
		content: "I adopted a cat named Luna yesterday in Berlin.",
		persist: async (edges) => {
			persistCalls += 1;
			persistedEdges.push(...edges);
		},
	});

	check("returns 2 edges", result.edges.length === 2, `edges=${result.edges.length}`);
	check("persist callback invoked exactly once", persistCalls === 1, `calls=${persistCalls}`);
	check(
		"persisted edges include Luna",
		persistedEdges.some((e) => e.label === "luna"),
	);
	check("no warnings when extractor is wired", result.warnings.length === 0);

	// Degraded-mode path: no extractor configured.
	const empty = await distillRawMessage(
		{},
		{
			userId: "u1",
			messageId: "m2",
			content: "anything",
		},
	);
	check(
		"empty edges + distill_extractor_not_configured warning without extractor",
		empty.edges.length === 0 &&
			empty.warnings.some((w: DistillWarning) => w.code === "distill_extractor_not_configured"),
	);
}

// ─── 2. derive ─────────────────────────────────────────────────────────────

async function runDerive() {
	console.log("  derive");

	const persistedFacts: DerivedFact[] = [];
	let persistCalls = 0;

	const deps: Pick<UnifiedSearchDeps, "deriver"> = {
		// Trivial deriver: always returns one summary fact.
		deriver: async (input) => [
			{
				text: `Summarized ${input.recentFactTexts.length} fact(s) for ${input.userId}`,
				kind: "summary",
				sources: input.recentFactTexts.map((_, i) => `src-${i}`),
				confidence: 0.7,
				derivedAt: Date.now(),
			},
		],
	};

	const result = await deriveFacts(deps, {
		userId: "u1",
		query: "cat preferences",
		candidateTexts: ["I adopted a cat named Luna", "Luna loves tuna", "Berlin is nice"],
		persist: async (facts) => {
			persistCalls += 1;
			persistedFacts.push(...facts);
		},
	});

	check("returns 1 fact", result.facts.length === 1);
	check("persist callback invoked exactly once", persistCalls === 1);
	check("persisted fact references 3 sources", persistedFacts[0]?.sources.length === 3);
	check("no warnings when deriver is wired", result.warnings.length === 0);

	// Degraded-mode path: no deriver configured.
	const noDeriver = await deriveFacts(
		{},
		{
			userId: "u1",
			candidateTexts: ["x"],
		},
	);
	check(
		"empty facts + derive_deriver_not_configured warning without deriver",
		noDeriver.facts.length === 0 &&
			noDeriver.warnings.some((w) => w.code === "derive_deriver_not_configured"),
	);
}

// ─── 3. search-signals ────────────────────────────────────────────────────

async function runSearchSignals() {
	console.log("  search-signals");

	const deps: UnifiedSearchDeps = {
		embedQuery: async () => new Array(4).fill(0.1),
		searchRawMessagesAnn: async () => [
			{
				id: "m1",
				content: "I adopted a cat named Luna.",
				similarity: 0.9,
				metadata: {},
			},
			{
				id: "m2",
				content: "Luna lives in Berlin.",
				similarity: 0.7,
				metadata: {},
			},
		],
		searchRawMessagesLexical: async () => [
			{
				id: "m2",
				content: "Luna lives in Berlin.",
				similarity: 0.5,
				metadata: { scoring: "bm25" },
			},
		],
		// Entity sub-query: claim m2 is an entity hit for "Luna".
		entitySearch: async () => [{ messageId: "m2", label: "Luna", score: 0.85 }],
	};

	const search = createUnifiedSearch(deps);
	const out = await search.search({
		userId: "u1",
		query: "anything here",
		mergeStrategy: "rrf",
	});

	const hitsWithSignals = out.results.filter((r) => Boolean(r.signals));
	check(
		"every hit carries signals.channels",
		hitsWithSignals.length === out.results.length,
		`${hitsWithSignals.length}/${out.results.length}`,
	);

	const m2 = out.results.find((r) => r.type === "memory" && r.id === "m2");
	const m2Signals = m2?.signals as HitSignals | undefined;
	check(
		"m2 was hit by semantic + lexical + entity",
		Boolean(
			m2Signals?.channels.includes("semantic") &&
				m2Signals?.channels.includes("lexical") &&
				m2Signals?.channels.includes("entity"),
		),
		`channels=${JSON.stringify(m2Signals?.channels ?? [])}`,
	);

	const m1 = out.results.find((r) => r.type === "memory" && r.id === "m1");
	const m1Signals = m1?.signals as HitSignals | undefined;
	check(
		"m1 only carries semantic (no lexical / entity hits)",
		Boolean(m1Signals?.channels.includes("semantic")) && m1Signals?.channels.length === 1,
		`channels=${JSON.stringify(m1Signals?.channels ?? [])}`,
	);

	check(
		"rrf score is mirrored on signals.rrf",
		m1Signals?.rrf !== undefined && typeof m1Signals.rrf === "number",
	);
}

// ─── Entry point ──────────────────────────────────────────────────────────

async function main() {
	console.log("[opencontext/extract-derive]");

	await runDistill();
	await runDerive();
	await runSearchSignals();

	const total = 3;
	console.log(`\nSummary: ${total} sections, ${failed} failed`);
	if (failed > 0) process.exitCode = 1;
}

runIfMain("extract-derive", main, import.meta.url);

export default main;
