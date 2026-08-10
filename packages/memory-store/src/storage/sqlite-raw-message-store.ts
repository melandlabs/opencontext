/**
 * SQLite-backed raw message store.
 *
 * Singleton manager used in Tauri (local) mode. The Tauri env is
 * sourced from the injected `MemoryStoreConfig.env`.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SQLiteRawMessageManager } from "@openloomi/sqlite";
import type { MemoryStoreEnv } from "../config";
import { isRawMessageChromaEnabled } from "./chroma-memory-index";

let manager: SQLiteRawMessageManager | null = null;

export function isSQLiteRawMessageStorageAvailable(
  env?: MemoryStoreEnv,
): boolean {
  return resolveEnv(env).isTauriMode();
}

export async function getSQLiteRawMessageManager(
  env?: MemoryStoreEnv,
): Promise<SQLiteRawMessageManager> {
  const e = resolveEnv(env);
  if (!e.isTauriMode()) {
    throw new Error(
      "SQLite raw message storage is only available in Tauri mode.",
    );
  }

  if (!manager) {
    const dbPath = e.getTauriDbPath?.() ?? process.env.TAURI_DB_PATH ?? "";
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
