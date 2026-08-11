/**
 * Top-level raw-message store facade.
 *
 * Backend selection is env-var driven:
 *
 *   - `OPENCONTEXT_MEMORY_STORE_BACKEND=postgres` → use the host's
 *     registered Postgres factory. A factory MUST be registered first
 *     via `registerPostgresFactory()`; otherwise this throws a clear
 *     error rather than silently falling back.
 *   - Any other value (including unset) → local SQLite. The default
 *     works in every host environment with no extra configuration.
 *
 * The facade exposes the common `RawMessageStorageManager` contract plus
 * a typed `searchMessagesSemantically` extension when present.
 */

import type { RawMessageStorageManager } from "@melandlabs/indexeddb/storage";
import type { MemoryStoreConfig, MemoryStoreEnv } from "../config";
import { hasPostgresFactory, resolvePostgresFactory } from "./postgres-raw-message-factory";
import { closeSQLiteRawMessageManager, getSQLiteRawMessageManager } from "./sqlite-raw-message-store";

export type RawMessageStorageBackend = "sqlite" | "postgres";

export type RawMessageStorageManagerWithSearch = RawMessageStorageManager & {
	searchMessagesSemantically?: (input: {
		userId: string;
		queryEmbedding: number[];
		embeddingModel?: string;
		limit?: number;
		scanLimit?: number;
		threshold?: number;
		includeArchived?: boolean;
		platform?: string;
		botId?: string;
		channel?: string;
		person?: string;
		startTime?: number;
		endTime?: number;
	}) => Promise<unknown[]>;
};

export interface CreateRawMessageStoreOptions {
	env?: MemoryStoreEnv;
}

export interface RawMessageStore {
	getManager(): Promise<RawMessageStorageManagerWithSearch>;
	getBackend(): RawMessageStorageBackend;
	isAvailable(): boolean;
	close(): Promise<void>;
}

function resolveBackend(env: MemoryStoreEnv | undefined): RawMessageStorageBackend {
	const explicit = process.env.OPENCONTEXT_MEMORY_STORE_BACKEND?.trim().toLowerCase();
	if (explicit === "postgres") return "postgres";
	// Any other value — including the default "sqlite", an unknown value,
	// or the env var being unset — falls through to local SQLite.
	return "sqlite";
}

function resolveEnv(_env?: MemoryStoreEnv): MemoryStoreEnv {
	return {};
}

export function createRawMessageStore(options: CreateRawMessageStoreOptions = {}): RawMessageStore {
	const env = resolveEnv(options.env);

	return {
		getBackend(): RawMessageStorageBackend {
			return resolveBackend(env);
		},
		isAvailable(): boolean {
			// SQLite is always available; postgres is only available when the
			// env var asks for it AND a factory has been registered.
			return resolveBackend(env) === "sqlite" || hasPostgresFactory();
		},
		async getManager(): Promise<RawMessageStorageManagerWithSearch> {
			if (resolveBackend(env) === "postgres") {
				const pg = await resolvePostgresFactory(env);
				if (!pg) {
					throw new Error(
						"OPENCONTEXT_MEMORY_STORE_BACKEND=postgres but no Postgres factory is registered. " +
							"Call registerPostgresFactory() at startup, or unset the env var to use the default SQLite backend.",
					);
				}
				return pg as unknown as RawMessageStorageManagerWithSearch;
			}
			return (await getSQLiteRawMessageManager(env)) as unknown as RawMessageStorageManagerWithSearch;
		},
		async close(): Promise<void> {
			// The sqlite singleton is process-wide, so close regardless of the
			// env var's current value — the previous call may have used it.
			await closeSQLiteRawMessageManager();
		},
	};
}

// Module-level singleton so existing call sites that imported the
// legacy `getRawMessageManager()` keep working without a refactor.
let moduleStore: RawMessageStore | null = null;
let moduleConfig: MemoryStoreConfig | null = null;

export function configureRawMessageStore(config: MemoryStoreConfig): RawMessageStore {
	moduleConfig = config;
	moduleStore = createRawMessageStore({ env: config.env });
	return moduleStore;
}

export function getRawMessageStorageBackend(): RawMessageStorageBackend {
	if (!moduleStore) {
		moduleStore = createRawMessageStore({ env: moduleConfig?.env });
	}
	return moduleStore.getBackend();
}

export function isRawMessageStorageAvailable(): boolean {
	if (!moduleStore) {
		moduleStore = createRawMessageStore({ env: moduleConfig?.env });
	}
	return moduleStore.isAvailable();
}

export async function getRawMessageManager(): Promise<RawMessageStorageManagerWithSearch> {
	if (!moduleStore) {
		moduleStore = createRawMessageStore({ env: moduleConfig?.env });
	}
	return moduleStore.getManager();
}

export async function closeRawMessageStore(): Promise<void> {
	if (!moduleStore) return;
	await moduleStore.close();
	moduleStore = null;
}
