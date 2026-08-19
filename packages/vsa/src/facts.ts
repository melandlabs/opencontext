/**
 * In-memory implementation of the {@link FactStore} contract.
 *
 * The store is process-local — there is no persistence layer. Hosts that
 * need durability should provide their own `FactStore` implementation
 * (e.g. backed by IndexedDB, SQLite, or Postgres). The contract is
 * intentionally small so the swap is mechanical.
 */

import type { FactSlot, FactStore } from "./types.js";

/**
 * Build a process-local `FactStore`. The returned store is mutable;
 * entries live until `clear()` is called on the scope or until the
 * process exits.
 */
function createInMemoryFactStore(): FactStore {
	const byScope = new Map<string, Map<string, string>>();

	function ensureScope(scope: string): Map<string, string> {
		let bucket = byScope.get(scope);
		if (!bucket) {
			bucket = new Map<string, string>();
			byScope.set(scope, bucket);
		}
		return bucket;
	}

	return {
		async put(scope: string, slot: FactSlot): Promise<void> {
			if (!scope) {
				throw new Error("FactStore.put: scope is required");
			}
			if (!slot || typeof slot.role !== "string" || typeof slot.filler !== "string") {
				throw new Error("FactStore.put: slot.role and slot.filler must be strings");
			}
			if (slot.role.length === 0) {
				throw new Error("FactStore.put: slot.role must be non-empty");
			}
			ensureScope(scope).set(slot.role, slot.filler);
		},
		async get(scope: string, role: string): Promise<string | undefined> {
			if (!scope || !role) {
				return undefined;
			}
			const bucket = byScope.get(scope);
			return bucket?.get(role);
		},
		async list(scope: string): Promise<FactSlot[]> {
			const bucket = byScope.get(scope);
			if (!bucket) {
				return [];
			}
			const out: FactSlot[] = [];
			for (const [role, filler] of bucket.entries()) {
				out.push({ role, filler });
			}
			return out;
		},
		async clear(scope: string): Promise<void> {
			byScope.delete(scope);
		},
	};
}

export { createInMemoryFactStore };
