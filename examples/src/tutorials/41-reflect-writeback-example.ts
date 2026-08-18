/**
 * Tutorial: `reflect()` (read-only) + `reflectWithPlan()` (agentic write-back).
 *
 * Walks the full loop end-to-end against an in-memory SQLite database:
 *
 *   1. Seed a few raw messages.
 *   2. `store.reflect(...)` — gather evidence + LLM synthesis (no writes).
 *   3. `store.reflectWithPlan({ dryRun: true })` — inspect the plan.
 *   4. `store.reflectWithPlan({ dryRun: false })` — actually write back.
 *   5. Re-query to confirm the read-only reflect still works afterwards.
 *
 * The demo wires a deterministic mock LLM (counts the evidence markers in
 * the prompt) so the run is reproducible without a real API key.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/41-reflect-writeback-example.ts
 */

import { runIfMain } from "../_helpers.ts";
import { createMemoryStore } from "@melandlabs/opencontext";

async function main(): Promise<void> {
	// Wire the mock LLM straight into the store so both `reflect` and
	// `reflectWithPlan` see the same hook. The mock is deterministic — it
	// counts the bracketed evidence markers in the prompt and lifts that
	// count into the answer text.
	const store = await createMemoryStore({
		unified: {
			embedQuery: async () => new Array(8).fill(0.1),
			reasoning: {
				complete: async (prompt) => {
					const evidenceCount = (prompt.match(/^\s*\[\d+\] /gm) ?? []).length;
					return JSON.stringify({
						answer: `mock LLM synthesis over ${evidenceCount} evidence item(s).`,
						confidence: 0.8,
					});
				},
			},
		},
	});

	// ── 1. Seed ────────────────────────────────────────────────────────────
	const raw = await store.getRawMessageManager();
	const now = Date.now();
	await raw.storeMessages([
		{
			messageId: `r-${now}-1`,
			userId: "u-42",
			content: "User said they love hiking in the mountains on weekends.",
			platform: "tutorial",
			botId: "tutorial-bot",
			timestamp: now - 7 * 24 * 60 * 60 * 1000,
			createdAt: now,
		},
		{
			messageId: `r-${now}-2`,
			userId: "u-42",
			content: "User mentioned trail running and mountain biking last spring.",
			platform: "tutorial",
			botId: "tutorial-bot",
			timestamp: now - 6 * 24 * 60 * 60 * 1000,
			createdAt: now,
		},
		{
			messageId: `r-${now}-3`,
			userId: "u-42",
			content: "User prefers dark mode in all IDEs.",
			platform: "tutorial",
			botId: "tutorial-bot",
			timestamp: now - 1 * 24 * 60 * 60 * 1000,
			createdAt: now,
		},
	]);
	console.log("[OK] seeded 3 raw messages");

	// ── 2. reflect() — read-only ───────────────────────────────────────────
	const readOnly = await store.reflect({
		userId: "u-42",
		query: "what does the user like?",
		tiers: ["raw"],
		limit: 10,
	});
	console.log(`[OK] reflect() answer: "${readOnly.answer}"`);
	console.log(`     evidence count: ${readOnly.evidence.length}`);
	console.log(`     warnings: ${JSON.stringify(readOnly.warnings)}`);
	if (!readOnly.answer.includes("mock LLM")) {
		throw new Error("Expected reflect() to call the configured LLM");
	}

	// ── 3. reflectWithPlan({ dryRun: true }) — inspect the plan ───────────
	const dry = await store.reflectWithPlan({
		userId: "u-42",
		query: "summarise the last week",
		ownerScope: { userId: "u-42" },
		tiers: ["raw"],
		limit: 10,
		dryRun: true,
	});
	console.log(`[OK] reflectWithPlan dryRun: applied=${dry.applied}, warnings=${dry.warnings.length}`);
	if (dry.applied !== false) {
		throw new Error("dryRun:true should set applied=false");
	}
	if (!dry.plan) {
		throw new Error("dryRun:true must still return the computed plan");
	}

	// ── 4. reflectWithPlan({ dryRun: false }) — actually write back ───────
	const applied = await store.reflectWithPlan({
		userId: "u-42",
		query: "summarise the last week",
		ownerScope: { userId: "u-42" },
		tiers: ["raw"],
		limit: 10,
		dryRun: false,
	});
	console.log(`[OK] reflectWithPlan applied: applied=${applied.applied}`);
	console.log(`     persistence: ${JSON.stringify(applied.persistenceResult ?? null)}`);
	console.log(`     deprecation counts: ${JSON.stringify(applied.deprecationCounts ?? [])}`);

	// ── 5. Re-query — verify the synthesis still works after writes ────────
	const after = await store.reflect({
		userId: "u-42",
		query: "summarise the last week",
		tiers: ["raw"],
		limit: 10,
	});
	console.log(`[OK] reflect() after apply: "${after.answer}"`);
	console.log(`     evidence count after: ${after.evidence.length}`);

	console.log("\n[OK] reflect + reflectWithPlan tutorial completed");
}

export default main;

runIfMain("reflect + reflectWithPlan tutorial", main);
