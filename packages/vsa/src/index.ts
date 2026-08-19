/**
 * `@melandlabs/vsa` — Vector Symbolic Architecture primitives.
 *
 * Public entry point. Re-exports the HRR primitives, the in-memory
 * fact store, and the shared types. See README.md for capacity notes
 * (≈ √D distinct records before crosstalk dominates).
 */

export type { FactSlot, FactStore, HRRVector } from "./types.js";

export {
	bind,
	cleanup,
	cosineSimilarity,
	dot,
	norm,
	randomHRRVector,
	superpose,
	unbind,
} from "./hrr.js";

export { createInMemoryFactStore } from "./facts.js";
export { createHRRFactStore, type HRRFactStoreOptions } from "./hrr-fact-store.js";
