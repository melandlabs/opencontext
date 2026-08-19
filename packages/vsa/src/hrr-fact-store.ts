/**
 * HRR-backed `FactStore`.
 *
 * Unlike {@link createInMemoryFactStore} (an exact string KV with unlimited
 * capacity), this store compresses every `(role, filler)` slot into a single
 * superposed HRR memory vector via `bind`, and recovers a filler on `get` by
 * `unbind`-ing with the role vector and running `cleanup` against the filler
 * vocabulary. The capacity is therefore bounded by crosstalk: roughly √D
 * clean records before approximate recall degrades — the same √D figure the
 * package README quotes for HRR.
 *
 * Use this when you want the HRR semantics (many slots packed into one vector,
 * on-demand recovery) and can tolerate approximate `get` under heavy load.
 * For exact, unbounded retrieval, use {@link createInMemoryFactStore}.
 */

import { bind, cleanup, randomHRRVector, superpose, unbind } from "./hrr.js";
import type { FactSlot, FactStore, HRRVector } from "./types.js";

export interface HRRFactStoreOptions {
	/** Vector dimension. Higher = more clean-recall capacity (≈ √D). Default 128. */
	dim?: number;
	/** Base seed for the deterministic role/filler vector mapping. Default 1. */
	seed?: number;
}

function hashString(value: string): number {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < value.length; i += 1) {
		h = Math.imul(h ^ value.charCodeAt(i), 16777619) >>> 0;
	}
	return h >>> 0;
}

function zeroVector(dim: number): HRRVector {
	return { dim, data: new Float32Array(dim) };
}

function createHRRFactStore(options: HRRFactStoreOptions = {}): FactStore {
	const dim = options.dim ?? 128;
	const seed = options.seed ?? 1;

	interface ScopeEntry {
		/** Superposed ⊕ bind(roleVec, fillerVec) over all live slots. */
		memory: HRRVector;
		/** Exact role → filler map; used to rebuild the memory on `put` / `clear`. */
		slots: Map<string, string>;
		/** Distinct fillers seen in this scope; the `cleanup` vocabulary. */
		fillers: string[];
	}

	const byScope = new Map<string, ScopeEntry>();

	// Deterministic, stable mapping from a string to its HRR vector so the
	// same role / filler always binds to the same vector within a store.
	const vectorFor = (value: string): HRRVector => randomHRRVector(dim, seed ^ hashString(value) || 1);

	function ensureScope(scope: string): ScopeEntry {
		let entry = byScope.get(scope);
		if (!entry) {
			entry = { memory: zeroVector(dim), slots: new Map(), fillers: [] };
			byScope.set(scope, entry);
		}
		return entry;
	}

	function rebuild(entry: ScopeEntry): void {
		const pairs = [...entry.slots.entries()];
		entry.memory =
			pairs.length > 0
				? superpose(pairs.map(([role, filler]) => bind(vectorFor(role), vectorFor(filler))))
				: zeroVector(dim);
		const vocab = new Set<string>();
		for (const filler of entry.slots.values()) {
			vocab.add(filler);
		}
		entry.fillers = [...vocab];
	}

	return {
		async put(scope: string, slot: FactSlot): Promise<void> {
			if (!scope) {
				throw new Error("HRRFactStore.put: scope is required");
			}
			if (!slot || typeof slot.role !== "string" || typeof slot.filler !== "string") {
				throw new Error("HRRFactStore.put: slot.role and slot.filler must be strings");
			}
			if (slot.role.length === 0) {
				throw new Error("HRRFactStore.put: slot.role must be non-empty");
			}
			const entry = ensureScope(scope);
			entry.slots.set(slot.role, slot.filler);
			rebuild(entry);
		},
		async get(scope: string, role: string): Promise<string | undefined> {
			if (!scope || !role) {
				return undefined;
			}
			const entry = byScope.get(scope);
			if (!entry || entry.slots.size === 0) {
				return undefined;
			}
			// Unknown role: return undefined rather than the nearest filler the
			// HRR recovery would otherwise guess at. Known roles are still
			// recovered through `bind` / `unbind` / `cleanup` below.
			if (!entry.slots.has(role)) {
				return undefined;
			}
			// Recover via HRR: unbind the memory with the role vector, then
			// disambiguate against the filler vocabulary.
			const recalled = unbind(entry.memory, vectorFor(role));
			const vocab = entry.fillers.map((filler) => vectorFor(filler));
			if (vocab.length === 0) {
				return undefined;
			}
			const best = cleanup(recalled, vocab);
			const index = vocab.indexOf(best);
			return index >= 0 ? entry.fillers[index] : undefined;
		},
		async list(scope: string): Promise<FactSlot[]> {
			const entry = byScope.get(scope);
			if (!entry) {
				return [];
			}
			const out: FactSlot[] = [];
			for (const [role, filler] of entry.slots.entries()) {
				out.push({ role, filler });
			}
			return out;
		},
		async clear(scope: string): Promise<void> {
			byScope.delete(scope);
		},
	};
}

export { createHRRFactStore };
