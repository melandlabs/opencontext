/**
 * demo: @melandlabs/memory-store — Vector Symbolic Architecture (VSA) verb.
 *
 * VSA stores (role, filler) bindings as holographic reduced
 * representations (HRR) and recalls the best-match filler for a given
 * role. Unlike semantic search (which returns top-K nearest neighbours),
 * recall returns exactly one best-match from a closed vocabulary.
 *
 * Use VSA when:
 *   - You have a known, closed set of answer categories (a vocabulary)
 *   - The question can be phrased as a role lookup ("what is the
 *     user's favorite color?")
 *   - You want millisecond-scale recall over a few thousand facts
 *
 * This demo walks through the four verbs on `store.vsa`:
 *   - `storeFact`    — persist a (role, filler) binding
 *   - `recall`       — rebuild the memory vector + best-match cleanup
 *   - `listFacts`    — read-side projection (no vectors)
 *   - `forget`       — soft-delete by id
 *
 * Vectors are produced by `@melandlabs/vsa`'s `randomHRRVector` (seeded
 * so the demo is reproducible). Real callers generate vectors via
 * `createInMemoryFactStore` or feed pre-computed vectors.
 */

import { createMemoryStore } from "@melandlabs/memory-store";
import { randomHRRVector } from "@melandlabs/vsa";
import { info, makeCheck, runSection, withTmp } from "../_helpers.ts";

const DIM = 128;

/**
 * `randomHRRVector` returns `{ dim, data }`. The memory-store VSA verb
 * takes a plain `number[]` / `Float32Array`, so we flatten the object
 * to its `data` buffer here.
 */
function toVector(seed: number): number[] {
	const v = randomHRRVector(DIM, seed);
	return Array.from(v.data);
}

export default async function demoVsa() {
	await runSection("demo: @melandlabs/memory-store (VSA verb)", async () => {
		const check = makeCheck("demo/vsa");

		await withTmp("memory-store-vsa", async (dir) => {
			// Scratch SQLite file so the demo doesn't touch the host's
			// `~/.opencontext/memory/store.db`.
			process.env.MEMORY_STORE_DB_PATH = `${dir}/store.db`;

			const store = await createMemoryStore();

			// 1. Build a closed vocabulary of candidate fillers. In
			//    production these would be the labelled answer space
			//    (e.g. mood ∈ { "happy", "neutral", "tired" }).
			const vocabulary = [
				{ label: "happy", vector: toVector(1) },
				{ label: "neutral", vector: toVector(2) },
				{ label: "tired", vector: toVector(3) },
			];
			info("demo/vsa", `vocabulary size = ${vocabulary.length}, dim = ${DIM}`);

			// 2. Persist three (role, filler) bindings. Each
			//    `randomHRRVector(seed)` is deterministic, so the same
			//    (roleVector, fillerVector) pair binds the same memory.
			const role = {
				label: "user:mood",
				vector: toVector(100),
			};
			const fillersToStore = [
				{ label: "happy", vector: vocabulary[0].vector },
				{ label: "happy", vector: vocabulary[0].vector },
				{ label: "happy", vector: vocabulary[0].vector },
			];

			const storedIds: string[] = [];
			for (const filler of fillersToStore) {
				const out = await store.vsa.storeFact({
					userId: "demo-user",
					scopeTag: "demo",
					roleLabel: role.label,
					roleVector: role.vector,
					fillerLabel: filler.label,
					fillerVector: filler.vector,
					dim: DIM,
				});
				storedIds.push(out.factId);
			}
			info("demo/vsa", `stored ${storedIds.length} facts (all bind to 'happy')`);

			check(
				"storeFact returned one factId per call",
				storedIds.length === fillersToStore.length && storedIds.every((id) => typeof id === "string"),
				`ids: ${storedIds.join(", ")}`,
			);
			check(
				"all generated factIds are unique",
				new Set(storedIds).size === storedIds.length,
			);

			// 3. Recall — superposed memory vector + best-match cleanup
			//    should pick the most-bound filler from the vocabulary.
			const recall = await store.vsa.recall({
				userId: "demo-user",
				scopeTag: "demo",
				roleLabel: role.label,
				roleVector: role.vector,
				vocabulary,
			});
			info(
				"demo/vsa",
				`recall best-match: ${recall.fillerLabel} (score=${recall.score.toFixed(4)}, factCount=${recall.factCount})`,
			);
			for (const w of recall.warnings) {
				info("demo/vsa", `  warning [${w.code}] ${w.message}`);
			}

			check(
				"recall returns a non-empty fillerLabel",
				typeof recall.fillerLabel === "string" && recall.fillerLabel.length > 0,
				`fillerLabel='${recall.fillerLabel}'`,
			);
			check(
				"recall picked 'happy' (the only filler we stored)",
				recall.fillerLabel === "happy",
				`got '${recall.fillerLabel}'`,
			);
			check(
				"allScores contains every vocabulary entry, sorted desc",
				recall.allScores.length === vocabulary.length &&
					recall.allScores[0].score >= recall.allScores[recall.allScores.length - 1].score,
				`scores: ${recall.allScores.map((s) => `${s.label}=${s.score.toFixed(3)}`).join(", ")}`,
			);
			check(
				"top score meets a reasonable confidence threshold",
				recall.score > 0.5,
				`top score = ${recall.score.toFixed(4)}`,
			);
			check(
				"recall is idempotent (same input → same output)",
				(await store.vsa.recall({
					userId: "demo-user",
					scopeTag: "demo",
					roleLabel: role.label,
					roleVector: role.vector,
					vocabulary,
				})).fillerLabel === "happy",
			);

			// 4. listFacts — read-side projection, vectors stripped.
			const facts = await store.vsa.listFacts({
				userId: "demo-user",
				scopeTag: "demo",
			});
			info("demo/vsa", `listFacts returned ${facts.length} fact(s)`);
			check(
				"listFacts returns the same count we stored",
				facts.length === fillersToStore.length,
				`got ${facts.length}`,
			);
			check(
				"listFacts entries are summaries (no vector field)",
				facts.every((f) => !("vector" in f) && !("roleVector" in f) && !("fillerVector" in f)),
			);
			check(
				"each summary has the right role + filler labels",
				facts.every((f) => f.roleLabel === "user:mood" && f.fillerLabel === "happy"),
			);

			// 5. forget — soft-delete by id, idempotent.
			const forgetFirst = await store.vsa.forget({
				userId: "demo-user",
				factIds: [storedIds[0]],
			});
			const forgetAgain = await store.vsa.forget({
				userId: "demo-user",
				factIds: [storedIds[0]],
			});
			info(
				"demo/vsa",
				`forget counts: first=${forgetFirst.deprecatedCount}, second=${forgetAgain.deprecatedCount}`,
			);
			check(
				"forget returned a positive count on the first call",
				forgetFirst.deprecatedCount >= 1,
				`deprecatedCount=${forgetFirst.deprecatedCount}`,
			);
			check(
				"forget is idempotent (second call returns 0)",
				forgetAgain.deprecatedCount === 0,
				`deprecatedCount=${forgetAgain.deprecatedCount}`,
			);

			// After the soft-delete, listFacts with default flags
			// (includeDeprecated: false) should no longer surface the
			// deleted fact.
			const after = await store.vsa.listFacts({
				userId: "demo-user",
				scopeTag: "demo",
			});
			check(
				"listFacts hides soft-deleted facts by default",
				after.length === facts.length - 1,
				`was ${facts.length}, now ${after.length}`,
			);
		});
	});
}
