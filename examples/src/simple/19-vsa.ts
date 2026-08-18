/**
 * demo: @melandlabs/vsa — Vector Symbolic Architecture primitives.
 *
 * Pairs the HRR primitives (`bind`/`unbind`/`superpose`/`cleanup`) with the
 * in-memory `FactStore` to model a tiny "user preferences" memory: each
 * fact is stored as a `(role, filler)` binding, all bindings are
 * superposed into a single memory vector, and recall unbind + cleanup
 * recovers the right filler from the vocabulary.
 *
 * The pipeline is the canonical HRR use-case OpenContext exposes via
 * `@melandlabs/vsa`. The point of this demo is to keep an executable
 * guard in front of the package so a regression in either the HRR
 * algebra (vector dim, normalisation, cleanup) or the FactStore scope
 * contract surfaces in `pnpm test` rather than in downstream callers.
 */

import {
	bind,
	cleanup,
	cosineSimilarity,
	createInMemoryFactStore,
	randomHRRVector,
	superpose,
	unbind,
} from "@melandlabs/vsa";
import { info, makeCheck, runSection } from "../_helpers.ts";

export default async function demoVsa() {
	await runSection("demo: @melandlabs/vsa — HRR primitives + in-memory FactStore", async () => {
		const check = makeCheck("demo/vsa");

		const dim = 128;
		const vocabulary: Array<{ id: string; vector: ReturnType<typeof randomHRRVector> }> = [
			{ id: "blue", vector: randomHRRVector(dim, 11) },
			{ id: "green", vector: randomHRRVector(dim, 12) },
			{ id: "red", vector: randomHRRVector(dim, 13) },
			{ id: "cat", vector: randomHRRVector(dim, 21) },
			{ id: "dog", vector: randomHRRVector(dim, 22) },
			{ id: "parrot", vector: randomHRRVector(dim, 23) },
		];
		const byId = new Map(vocabulary.map((entry) => [entry.id, entry.vector]));

		const roles = {
			favoriteColor: randomHRRVector(dim, 100),
			pet: randomHRRVector(dim, 101),
		};

		// FactStore scope contract: put/list/clear all keyed by a single
		// scope string so multiple peers can coexist in one store.
		const store = createInMemoryFactStore();
		const scope = "user-42";

		await store.put(scope, { role: "favoriteColor", filler: "blue" });
		await store.put(scope, { role: "pet", filler: "cat" });
		const stored = await store.list(scope);
		info("demo/vsa", `stored ${stored.length} fact(s) for scope "${scope}": ${JSON.stringify(stored)}`);
		check("FactStore.put persists two facts under the scope", stored.length === 2, String(stored.length));

		// Build the superposed memory vector: bind(role, filler) for each
		// fact, then superpose the bindings together.
		const memory = superpose([
			bind(roles.favoriteColor, byId.get("blue")!),
			bind(roles.pet, byId.get("cat")!),
		]);
		info("demo/vsa", `memory vector dim=${memory.dim}`);
		check("superpose returns a vector of the requested dim", memory.dim === dim, String(memory.dim));

		// Recall: unbind by the pet role, then cleanup against the pet
		// vocabulary. The top-cleaned filler should be the original "cat"
		// binding (i.e. cosine similarity near 1).
		const recalledPetVec = unbind(memory, roles.pet);
		const petVocabulary = vocabulary
			.filter((entry) => entry.id === "cat" || entry.id === "dog" || entry.id === "parrot")
			.map((entry) => entry.vector);
		const recalledPet = cleanup(recalledPetVec, petVocabulary);
		const targetPet = byId.get("cat")!;
		const petScore = cosineSimilarity(recalledPet, targetPet);
		info("demo/vsa", `recall pet → cosine(original cat) = ${petScore.toFixed(4)}`);
		check("unbind + cleanup recovers the cat filler (cosine ≥ 0.5)", petScore >= 0.5, petScore.toFixed(4));

		// And the same for the color slot. Two slots in the same memory
		// vector shouldn't leak into each other under HRR cleanup.
		const recalledColorVec = unbind(memory, roles.favoriteColor);
		const colorVocabulary = vocabulary
			.filter((entry) => entry.id === "blue" || entry.id === "green" || entry.id === "red")
			.map((entry) => entry.vector);
		const recalledColor = cleanup(recalledColorVec, colorVocabulary);
		const colorScore = cosineSimilarity(recalledColor, byId.get("blue")!);
		info("demo/vsa", `recall color → cosine(original blue) = ${colorScore.toFixed(4)}`);
		check(
			"unbind + cleanup recovers the blue filler (cosine ≥ 0.5)",
			colorScore >= 0.5,
			colorScore.toFixed(4),
		);

		// Sanity: pet and color slots don't collapse onto each other.
		const crossScore = cosineSimilarity(recalledPet, byId.get("blue")!);
		info("demo/vsa", `cross-slot (pet vs blue) cosine = ${crossScore.toFixed(4)}`);
		check(
			"cross-slot recall stays below the on-target recall",
			crossScore < petScore,
			`cross=${crossScore.toFixed(4)} on-target=${petScore.toFixed(4)}`,
		);

		// Clear the scope and confirm the store is empty.
		await store.clear(scope);
		const after = await store.list(scope);
		info("demo/vsa", `after clear: ${after.length} fact(s) remaining`);
		check("FactStore.clear empties the scope", after.length === 0, String(after.length));
	});
}
