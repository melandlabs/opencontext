/**
 * SQLite-backed raw message store.
 *
 * Singleton manager. Local SQLite is the default backend for the memory
 * store — no host-mode check, no env-var opt-in. The DB path is resolved
 * from (in order):
 *   1. `MEMORY_STORE_DB_PATH`              — recommended knob
 *   2. `~/.opencontext/memory/store.db`    — last-resort default
 *
 * The `env?` parameter on the exported functions is kept for back-compat
 * with the historical `MemoryStoreEnv` interface but is no longer read.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SQLiteRawMessageManager } from "@melandlabs/sqlite";
import type { MemoryStoreEnv } from "../config";
import { isRawMessageChromaEnabled } from "./chroma-memory-index";

let manager: SQLiteRawMessageManager | null = null;

const DEFAULT_SQLITE_PATH = join(homedir(), ".opencontext", "memory", "store.db");

/**
 * Resolve the SQLite DB file path from env vars. Exposed so other storage
 * layers (vector index) can stay in sync with the same default.
 */
export function resolveSQLiteRawMessageDbPath(dbPath?: string): string {
	if (dbPath && dbPath.length > 0) return dbPath;
	const fromEnv = process.env.MEMORY_STORE_DB_PATH?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_SQLITE_PATH;
}

/**
 * Local SQLite is the default. Every host (Tauri, server, CLI, tests) can
 * open the manager; the only failure mode is filesystem write permission.
 */
export function isSQLiteRawMessageStorageAvailable(_env?: MemoryStoreEnv): boolean {
	return true;
}

export async function getSQLiteRawMessageManager(
	options: { env?: MemoryStoreEnv; dbPath?: string } = {},
): Promise<SQLiteRawMessageManager> {
	if (!manager) {
		const dbPath = resolveSQLiteRawMessageDbPath(options.dbPath);
		mkdirSync(dirname(dbPath), { recursive: true });
		manager = new SQLiteRawMessageManager({
			dbPath,
			enableVectorSearch: !isRawMessageChromaEnabled(),
		});
		await manager.init();
	}

	return manager;
}

export async function closeSQLiteRawMessageManager(): Promise<void> {
	if (!manager) {
		return;
	}
	await manager.close();
	manager = null;
}

/**
 * Test-only: reset the singleton. Used by vitest between test cases.
 */
export function __resetSQLiteRawMessageManagerForTests(): void {
	manager = null;
}

/**
 * BM25 lexical proxy over the SQLite FTS5 index. Mirrors
 * `SQLiteRawMessageManager.lexicalSearchMessages` so callers downstream of the
 * raw-message facade can opt in to a second ranking signal.
 */
export async function lexicalSearchRawMessages(input: {
	userId: string;
	keywords: string[];
	limit?: number;
	includeArchived?: boolean;
	platform?: string;
	botId?: string;
}): Promise<unknown[]> {
	const mgr = await getSQLiteRawMessageManager();
	if (typeof mgr.lexicalSearchMessages !== "function") {
		return [];
	}
	return mgr.lexicalSearchMessages(input);
}

// Kept for back-compat with the historical `MemoryStoreEnv` interface.
// The resolved env is no longer read by the SQLite layer, but the symbol
// stays exported so external code that still calls `resolveEnv` compiles.
// biome-ignore lint/correctness/noUnusedVariables: kept for back-compat with the historical MemoryStoreEnv interface
function resolveEnv(_env?: MemoryStoreEnv): MemoryStoreEnv {
	return {};
}
