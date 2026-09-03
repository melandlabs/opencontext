/**
 * @melandlabs/memory-store — SQLite raw-message backend pinning.
 *
 * Pins the contract for the new env-var-driven backend:
 *
 *   1. `isSQLiteRawMessageStorageAvailable()` — always true. SQLite is
 *      the unconditional default for every host (Tauri, server, CLI, tests).
 *   2. `resolveSQLiteRawMessageDbPath()` — resolves the DB file path from
 *      (in order): `MEMORY_STORE_DB_PATH` → `~/.opencontext/memory/store.db`.
 *      TAURI_DB_PATH is no longer read — Tauri hosts should set
 *      MEMORY_STORE_DB_PATH like any other host.
 *   3. `getSQLiteRawMessageManager()` — opens the file at the resolved
 *      path, creating the parent dir if needed, and is idempotent across
 *      calls (process-wide singleton).
 *
 * The `MemoryStoreEnv` parameter is kept for back-compat but is no longer
 * read; the tests assert that it is ignored rather than consulted.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getOpenContextDir() prefers OPENCONTEXT_HOME over HOME. The path resolver
// re-reads it on every call, so just clearing it in beforeEach would work —
// but vi.hoisted also protects any module-load-time path resolution that may
// be added later. A host with OPENCONTEXT_HOME pre-set (e.g. pointing at
// ~/.alloomi) would otherwise leak its real dir into the home-dir-default
// assertions below.
vi.hoisted(() => {
	// getOpenContextDir() treats any non-empty override as authoritative,
	// so explicitly clearing it forces the fall-through to HOME.
	process.env.OPENCONTEXT_HOME = "";
});

import {
	__resetSQLiteRawMessageManagerForTests,
	closeSQLiteRawMessageManager,
	getSQLiteRawMessageManager,
	isSQLiteRawMessageStorageAvailable,
	resolveSQLiteRawMessageDbPath,
} from "./sqlite-raw-message-store";

/** A scratch dir for any sqlite files these tests create. */
let scratchDir: string;
/** Snapshot of the env var this layer reads, so we can restore it. */
const ORIGINAL_MEMORY_STORE_DB_PATH = process.env.MEMORY_STORE_DB_PATH;

beforeEach(() => {
	// The sqlite manager is a process-wide singleton. Wipe it between
	// tests so each test can re-initialise against its own scratch dir.
	__resetSQLiteRawMessageManagerForTests();
	scratchDir = mkdtempSync(join(tmpdir(), "memory-store-test-"));
});

afterEach(async () => {
	await closeSQLiteRawMessageManager().catch(() => {});
	__resetSQLiteRawMessageManagerForTests();
	rmSync(scratchDir, { recursive: true, force: true });
	// biome-ignore lint/performance/noDelete: assigning undefined would set the var to the string "undefined".
	if (ORIGINAL_MEMORY_STORE_DB_PATH === undefined) delete process.env.MEMORY_STORE_DB_PATH;
	else process.env.MEMORY_STORE_DB_PATH = ORIGINAL_MEMORY_STORE_DB_PATH;
});

describe("isSQLiteRawMessageStorageAvailable", () => {
	it("always returns true (sqlite is the unconditional default)", () => {
		expect(isSQLiteRawMessageStorageAvailable()).toBe(true);
	});

	it("returns true even with no env vars set", () => {
		// biome-ignore lint/performance/noDelete: the var must be absent, not the string "undefined".
		delete process.env.MEMORY_STORE_DB_PATH;
		expect(isSQLiteRawMessageStorageAvailable()).toBe(true);
	});

	it("ignores the env argument (the historical MemoryStoreEnv is no longer read)", () => {
		// Passing an empty object — the new MemoryStoreEnv is {} — must not throw.
		expect(isSQLiteRawMessageStorageAvailable({})).toBe(true);
	});
});

describe("resolveSQLiteRawMessageDbPath", () => {
	it("honours MEMORY_STORE_DB_PATH when set", () => {
		const explicit = join(scratchDir, "from-env.db");
		process.env.MEMORY_STORE_DB_PATH = explicit;
		expect(resolveSQLiteRawMessageDbPath()).toBe(explicit);
	});

	it("falls back to the home-dir default when MEMORY_STORE_DB_PATH is unset", () => {
		// biome-ignore lint/performance/noDelete: the var must be absent, not the string "undefined".
		delete process.env.MEMORY_STORE_DB_PATH;
		const resolved = resolveSQLiteRawMessageDbPath();
		expect(normalize(resolved).endsWith(normalize("/.opencontext/memory/store.db"))).toBe(true);
	});

	it("treats an empty MEMORY_STORE_DB_PATH as unset", () => {
		process.env.MEMORY_STORE_DB_PATH = "";
		const resolved = resolveSQLiteRawMessageDbPath();
		expect(normalize(resolved).endsWith(normalize("/.opencontext/memory/store.db"))).toBe(true);
	});

	it("ignores TAURI_DB_PATH — Tauri hosts must set MEMORY_STORE_DB_PATH", () => {
		// Pinning the deliberate removal of the legacy Tauri coupling:
		// even if TAURI_DB_PATH is set, it must NOT influence the
		// resolved path. Tauri hosts point MEMORY_STORE_DB_PATH at their
		// data dir like any other host.
		process.env.MEMORY_STORE_DB_PATH = join(scratchDir, "memory.db");
		process.env.TAURI_DB_PATH = join(scratchDir, "should-be-ignored.db");
		expect(resolveSQLiteRawMessageDbPath()).toBe(join(scratchDir, "memory.db"));
	});
});

describe("getSQLiteRawMessageManager", () => {
	it("opens the file at MEMORY_STORE_DB_PATH and creates the parent dir", async () => {
		const dbPath = join(scratchDir, "nested", "store.db");
		process.env.MEMORY_STORE_DB_PATH = dbPath;

		const manager = await getSQLiteRawMessageManager();
		expect(manager).toBeTruthy();

		const { statSync, existsSync } = await import("node:fs");
		expect(existsSync(dbPath)).toBe(true);
		expect(statSync(dbPath).size).toBeGreaterThan(0);

		await closeSQLiteRawMessageManager();
	});

	it("ignores the env argument (the historical MemoryStoreEnv is no longer read)", async () => {
		process.env.MEMORY_STORE_DB_PATH = join(scratchDir, "store.db");

		const manager = await getSQLiteRawMessageManager({});
		expect(manager).toBeTruthy();

		const { existsSync } = await import("node:fs");
		expect(existsSync(join(scratchDir, "store.db"))).toBe(true);

		await closeSQLiteRawMessageManager();
	});

	it("is idempotent — second call returns the same singleton", async () => {
		process.env.MEMORY_STORE_DB_PATH = join(scratchDir, "store.db");

		const first = await getSQLiteRawMessageManager();
		const second = await getSQLiteRawMessageManager();
		expect(second).toBe(first);

		await closeSQLiteRawMessageManager();
	});
});
