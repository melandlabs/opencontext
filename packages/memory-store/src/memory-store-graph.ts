/**
 * `attachMemoryGraphStore` — opt-in helper for hosts that want to wire
 * a memory graph store onto an existing `MemoryStore` without going
 * through `createMemoryStore({ graphStore })`.
 *
 * Usage:
 * ```ts
 * const store = await createMemoryStore();
 * attachMemoryGraphStore(store, {
 *   storage: indexedDbStorage,
 *   ownerScope: { userId: "u-42" },
 * });
 * ```
 *
 * Returns the same `MemoryStore` reference for chaining. When
 * `storage.compareAndSwapGraphLedger` is missing, no graph store is
 * attached and a warning is emitted via the supplied logger — callers
 * may still run `reflectWithPlan`, but it will skip `persistPlan` and
 * emit a `reflect_apply_graph_store_not_configured` warning. The
 * deprecation path through `storage.deprecateRecords` continues to
 * work as long as a `MemoryStorageAdapter` is wired elsewhere.
 */

import {
	type RawMessageGraphEvolutionStorage,
	createRawMessageMemoryGraphStore,
} from "@melandlabs/indexeddb";
import type { OwnerScope } from "@melandlabs/memory-consolidation";
import type { MemoryStore } from "./index";

export interface AttachMemoryGraphStoreInput {
	storage: RawMessageGraphEvolutionStorage;
	ownerScope: OwnerScope;
	botId?: string;
	now?: () => number;
	/**
	 * Optional logger; falls back to `console`. The helper does not log on
	 * the happy path; it only warns when `compareAndSwapGraphLedger` is
	 * missing on the storage.
	 */
	logger?: Pick<Console, "warn">;
}

export function attachMemoryGraphStore(store: MemoryStore, input: AttachMemoryGraphStoreInput): MemoryStore {
	const logger = input.logger ?? console;
	if (typeof input.storage.compareAndSwapGraphLedger !== "function") {
		logger.warn?.(
			"[memory-store] attachMemoryGraphStore: storage is missing `compareAndSwapGraphLedger`; no graph store attached.",
		);
		return store;
	}

	const graphStore = createRawMessageMemoryGraphStore({
		storage: input.storage,
		ownerScope: input.ownerScope,
		botId: input.botId,
		now: input.now,
	});

	store.graphStore = graphStore;
	return store;
}
