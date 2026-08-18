/**
 * Public type surface for `@melandlabs/vsa`.
 *
 * The package has two layers:
 *
 *   1. {@link HRRVector} + the `bind`/`unbind`/`superpose`/`cleanup`
 *      primitives — pure math, no state.
 *   2. {@link FactStore} — a key/value store of role/filler pairs that the
 *      host application owns. The store has no implicit vocabulary; the
 *      caller decides which roles exist.
 */

/**
 * A role/filler binding vector (HRR-style). Stored as a `Float32Array`
 * so it can be reused across many bind/unbind calls without
 * allocations.
 *
 * Typical dimensions: 64 / 128 / 256. Higher dimensions improve the
 * effective capacity (≈ √D clean records before crosstalk dominates),
 * at linear cost.
 */
export interface HRRVector {
	readonly data: Float32Array;
	readonly dim: number;
}

/**
 * A single fact slot stored in the {@link FactStore}. `role` and `filler`
 * are caller-chosen string keys — the store does not interpret them.
 */
export interface FactSlot {
	role: string;
	filler: string;
}

/**
 * Key/value store of role/filler pairs.
 *
 * - `scope` namespaces the slot collection (e.g. one per conversation).
 * - `role` is the lookup key (e.g. `"favoriteColor"`).
 * - `filler` is the stored value (e.g. `"blue"`).
 *
 * Two implementations are provided:
 *
 * - `createInMemoryFactStore()` — an **exact** string KV. Retrieval is
 *   unbounded and lossless; it does not use the HRR math.
 * - `createHRRFactStore()` — an **HRR-backed** store. It packs every slot
 *   into one superposed vector and recovers fillers via `bind` / `unbind` /
 *   `cleanup`. Capacity is bounded by crosstalk (≈ √D clean records before
 *   approximate recall degrades), which is the √D figure quoted in the README.
 *
 * Hosts may also supply their own persistent backend.
 */
export interface FactStore {
	put(scope: string, slot: FactSlot): Promise<void>;
	get(scope: string, role: string): Promise<string | undefined>;
	list(scope: string): Promise<FactSlot[]>;
	clear(scope: string): Promise<void>;
}
