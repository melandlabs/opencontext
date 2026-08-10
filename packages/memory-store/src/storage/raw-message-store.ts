/**
 * Top-level raw-message store facade.
 *
 * Selects between sqlite (Tauri) and postgres (host-registered)
 * backends based on `MemoryStoreEnv.isTauriMode()`. The facade exposes
 * the common `RawMessageStorageManager` contract plus a typed
 * `searchMessagesSemantically` extension when present.
 */

import type { RawMessageStorageManager } from "@opencontext/indexeddb/storage";
import type { MemoryStoreConfig, MemoryStoreEnv } from "../config";
import {
	getSQLiteRawMessageManager,
	isSQLiteRawMessageStorageAvailable,
	closeSQLiteRawMessageManager,
} from "./sqlite-raw-message-store";
import {
	hasPostgresFactory,
	resolvePostgresFactory,
} from "./postgres-raw-message-factory";

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

function resolveEnv(env?: MemoryStoreEnv): MemoryStoreEnv {
	if (env) return env;
	return {
		isTauriMode: () =>
			process.env.IS_TAURI === "true" ||
			typeof process.env.TAURI_MODE === "string",
		getTauriDbPath: () => process.env.TAURI_DB_PATH ?? "",
		getTauriDataDir: () => process.env.TAURI_DATA_DIR ?? "",
	};
}

export function createRawMessageStore(
	options: CreateRawMessageStoreOptions = {},
): RawMessageStore {
	const env = resolveEnv(options.env);

	return {
		getBackend(): RawMessageStorageBackend {
			return isSQLiteRawMessageStorageAvailable(env) ? "sqlite" : "postgres";
		},
		isAvailable(): boolean {
			return isSQLiteRawMessageStorageAvailable(env) || hasPostgresFactory();
		},
		async getManager(): Promise<RawMessageStorageManagerWithSearch> {
			if (isSQLiteRawMessageStorageAvailable(env)) {
				return (await getSQLiteRawMessageManager(
					env,
				)) as unknown as RawMessageStorageManagerWithSearch;
			}
			const pg = await resolvePostgresFactory(env);
			if (!pg) {
				throw new Error(
					"No raw-message backend available. SQLite is disabled (not Tauri) and no Postgres factory is registered.",
				);
			}
			return pg as unknown as RawMessageStorageManagerWithSearch;
		},
		async close(): Promise<void> {
			if (isSQLiteRawMessageStorageAvailable(env)) {
				await closeSQLiteRawMessageManager();
			}
		},
	};
}

// Module-level singleton so existing call sites that imported the
// legacy `getRawMessageManager()` keep working without a refactor.
let moduleStore: RawMessageStore | null = null;
let moduleConfig: MemoryStoreConfig | null = null;

export function configureRawMessageStore(
	config: MemoryStoreConfig,
): RawMessageStore {
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
