/**
 * `opencontext add` — integration test (real SQLite round-trip).
 *
 * Exercises the full CLI command against a temp-backed
 * `@melandlabs/memory-store`:
 *
 *   1. configureRawMessageStore({ dbPath: tmp })
 *   2. runAdd(...)            — writes via manager.storeMessages
 *   3. manager.queryMessages  — reads back what was actually persisted
 *
 * Gates: skipped automatically when `OPENCONTEXT_INTEGRATION=0` so CI
 * without a writable tempdir can opt out. The integration config in
 * vitest.integration.config.ts excludes these from `pnpm test`; run
 * with `pnpm --filter @melandlabs/opencontext test:integration`.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeRawMessageStore, getRawMessageManager } from "@melandlabs/memory-store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseAddArgs, runAdd } from "./add";

const integrationEnabled = process.env.OPENCONTEXT_INTEGRATION !== "0";

const describeIf = integrationEnabled ? describe : describe.skip;

// Snapshot the env var so we restore it after the run instead of leaking
// a temp path into the parent process.
const ORIGINAL_DB_PATH = process.env.MEMORY_STORE_DB_PATH;

let tmpDir: string;
let dbPath: string;

beforeAll(() => {
	tmpDir = join(tmpdir(), `opencontext-add-it-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });
	dbPath = join(tmpDir, "store.db");
});

afterAll(async () => {
	try {
		await closeRawMessageStore();
	} catch {
		// best-effort cleanup
	}
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
	if (ORIGINAL_DB_PATH === undefined) {
		// biome-ignore lint/performance/noDelete: env-restoration must delete (not assign) so the key is truly removed; `= undefined` coerces to the string "undefined" (see doctor.test.ts).
		delete process.env.MEMORY_STORE_DB_PATH;
	} else {
		process.env.MEMORY_STORE_DB_PATH = ORIGINAL_DB_PATH;
	}
});

beforeEach(async () => {
	// Force-close any cached module-level manager from a previous test, then
	// point the env var at our temp file so the next `getRawMessageManager()`
	// resolves to it via the documented env-var precedence.
	await closeRawMessageStore();
	process.env.MEMORY_STORE_DB_PATH = dbPath;
});

afterEach(async () => {
	await closeRawMessageStore();
});

describeIf("opencontext add — real storage round-trip", () => {
	it("writes a single message and reads it back via queryMessages", async () => {
		const exit = await runAdd(
			parseAddArgs([
				"--user",
				"alice",
				"--bot",
				"general",
				"--text",
				"Discussed Q4 roadmap",
				"--source",
				"meeting://2026-08-20",
				"--kind",
				"experience",
				"--channel",
				"#eng",
				"--person",
				"u_42",
				"--tag",
				"topic=roadmap",
				"--tag=team=eng",
			]),
		);
		expect(exit).toBe(0);

		const manager = await getRawMessageManager();
		const rows = await manager.queryMessages({ userId: "alice", limit: 10 });
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (!row) throw new Error("expected one persisted row");
		expect(row.userId).toBe("alice");
		expect(row.botId).toBe("general");
		expect(row.platform).toBe("cli");
		expect(row.content).toBe("Discussed Q4 roadmap");
		expect(row.channel).toBe("#eng");
		expect(row.person).toBe("u_42");
		expect(row.timestamp).toBeGreaterThan(0);
		expect(row.createdAt).toBeGreaterThan(0);
		// metadata survives round-trip (kind is now a top-level factType, not in metadata)
		expect(row.metadata).toEqual({
			source: "meeting://2026-08-20",
			topic: "roadmap",
			team: "eng",
		});
		expect(row.factType).toBe("experience");
	});

	it("default --user falls back to 'default' in storage", async () => {
		await runAdd(parseAddArgs(["--text", "smoke"]));

		const manager = await getRawMessageManager();
		const rows = await manager.queryMessages({ userId: "default", limit: 5 });
		expect(rows.some((r) => r.content === "smoke")).toBe(true);
	});

	it("parses --at into a numeric timestamp that persists", async () => {
		await runAdd(
			parseAddArgs(["--user", "alice", "--text", "historic entry", "--at", "2026-01-15T10:00:00Z"]),
		);

		const manager = await getRawMessageManager();
		const rows = await manager.queryMessages({ userId: "alice", limit: 5 });
		const found = rows.find((r) => r.content === "historic entry");
		expect(found?.timestamp).toBe(Date.parse("2026-01-15T10:00:00Z"));
	});

	it("persists auto-generated messageId as a UUID-shaped string", async () => {
		await runAdd(parseAddArgs(["--user", "alice", "--text", "uuid check"]));

		const manager = await getRawMessageManager();
		const rows = await manager.queryMessages({ userId: "alice", limit: 5 });
		const found = rows.find((r) => r.content === "uuid check");
		expect(found?.messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	});
});
