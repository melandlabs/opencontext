/**
 * Tutorial: `FactType` classification + the `factTypes` read-side filter.
 *
 * Atomic facts are classified at extraction time as one of three kinds:
 *
 *   - `world`         — facts about the world
 *   - `experience`    — first-person events
 *   - `mental_model`  — generalised patterns
 *
 * The classification rides along the `RawMessage.factType?` field and
 * surfaces on the read side as the `factTypes` filter on
 * `searchUnifiedMemory`. This tutorial exercises both ends.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/42-facttype-filter-example.ts
 */

import { runIfMain } from "../_helpers.ts";
import { createMemoryStore } from "@melandlabs/opencontext";

async function main(): Promise<void> {
	const store = await createMemoryStore();
	const raw = await store.getRawMessageManager();

	// Use a unique userId per run so other tutorials sharing the default
	// sqlite db don't pollute this query.
	const userId = `u-facttype-${Date.now()}`;

	const now = Date.now();
	await raw.storeMessages([
		{
			messageId: `f-${now}-world`,
			userId,
			content: "The Pacific Crest Trail is one of the longest hiking routes in the world.",
			platform: "tutorial",
			botId: "tutorial-bot",
			timestamp: now,
			createdAt: now,
			factType: "world",
		},
		{
			messageId: `f-${now}-exp`,
			userId,
			content: "I went hiking in the mountains last weekend.",
			platform: "tutorial",
			botId: "tutorial-bot",
			timestamp: now,
			createdAt: now,
			factType: "experience",
		},
		{
			messageId: `f-${now}-model`,
			userId,
			content: "User prefers outdoor hiking activities on Saturdays.",
			platform: "tutorial",
			botId: "tutorial-bot",
			timestamp: now,
			createdAt: now,
			factType: "mental_model",
		},
	]);
	console.log(`[OK] seeded 3 raw messages (world, experience, mental_model) for ${userId}`);

	// ── 1. No filter — all 3 land ──────────────────────────────────────────
	// Restrict to `["memory"]` so this demo isn't polluted by insights or
	// knowledge hits (which never carry a `factType`).
	const all = await store.searchUnifiedMemory({
		userId,
		query: "hiking",
		sources: ["memory"],
		limit: 10,
		threshold: -1, // disable threshold for the demo
	});
	console.log(`[OK] unfiltered: count=${all.count}`);
	if (all.count < 3) {
		throw new Error(`Expected at least 3 hits unfiltered, got ${all.count}`);
	}

	// ── 2. factTypes: ['experience'] — narrow to first-person events ──────
	const onlyExp = await store.searchUnifiedMemory({
		userId,
		query: "hiking",
		sources: ["memory"],
		factTypes: ["experience"],
		limit: 10,
		threshold: -1,
	});
	console.log(`[OK] factTypes=[experience]: count=${onlyExp.count}`);
	for (const hit of onlyExp.results) {
		console.log(`     - [${hit.type}] factType=${hit.metadata.factType}`);
	}
	const expOnly = onlyExp.results.every((hit) => hit.metadata.factType === "experience");
	if (!expOnly || onlyExp.count < 1) {
		throw new Error("Expected only experience-class messages when factTypes=['experience']");
	}

	// ── 3. factTypes: ['mental_model'] — narrow to generalised patterns ────
	const onlyModel = await store.searchUnifiedMemory({
		userId,
		query: "hiking",
		sources: ["memory"],
		factTypes: ["mental_model"],
		limit: 10,
		threshold: -1,
	});
	console.log(`[OK] factTypes=[mental_model]: count=${onlyModel.count}`);
	const modelOnly = onlyModel.results.every((hit) => hit.metadata.factType === "mental_model");
	if (!modelOnly || onlyModel.count < 1) {
		throw new Error("Expected only mental_model-class messages when factTypes=['mental_model']");
	}

	console.log("\n[OK] FactType filter tutorial completed");
}

export default main;

runIfMain("FactType filter tutorial", main);
