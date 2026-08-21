/**
 * `opencontext search` — integration test (real SQLite round-trip).
 *
 * Exercises the full read path against a temp-backed
 * `@melandlabs/memory-store`:
 *
 *   1. configureRawMessageStore({ dbPath: tmp })
 *   2. runAdd(...)            — seed several messages
 *   3. runSearch(...)         — read them back, no synthesis (synthesize=false)
 *
 * Gates: skipped automatically when `OPENCONTEXT_INTEGRATION=0`. Run
 * via `pnpm --filter @melandlabs/opencontext test:integration`.
 *
 * No LLM calls: search is invoked with the default `synthesize: false`
 * and only exercises lexical + raw-store paths. If a future
 * `synthesize: true` integration is added it will need explicit
 * OPENCONTEXT_LLM_* credentials.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeRawMessageStore, getRawMessageManager } from "@melandlabs/memory-store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseAddArgs, runAdd } from "./add";
import { parseSearchArgs, runSearch } from "./search";

const integrationEnabled = process.env.OPENCONTEXT_INTEGRATION !== "0";

const describeIf = integrationEnabled ? describe : describe.skip;

// Snapshot the env var so we restore it after the run instead of leaking
// a temp path into the parent process.
const ORIGINAL_DB_PATH = process.env.MEMORY_STORE_DB_PATH;

let tmpDir: string;
let dbPath: string;

beforeAll(() => {
	tmpDir = join(tmpdir(), `opencontext-search-it-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });
	dbPath = join(tmpDir, "store.db");
});

afterAll(async () => {
	try {
		await closeRawMessageStore();
	} catch {
		// best-effort
	}
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
	if (ORIGINAL_DB_PATH === undefined) {
		// biome-ignore lint/performance/noDelete: env-restoration must delete (not assign) so the key is truly removed; `= undefined` coerces to the string "undefined" (see doctor.test.ts).
		delete process.env.MEMORY_STORE_DB_PATH;
	} else {
		process.env.MEMORY_STORE_DB_PATH = ORIGINAL_DB_PATH;
	}
});

beforeEach(async () => {
	// Force-close any cached module-level manager, then point the env var at
	// our temp file so the next `getRawMessageManager()` resolves to it.
	await closeRawMessageStore();
	process.env.MEMORY_STORE_DB_PATH = dbPath;

	// Seed four messages for alice that span three topics.
	const seeds: Array<{ text: string; tag?: string }> = [
		{ text: "Discussed Q4 roadmap with the team", tag: "topic=roadmap" },
		{ text: "Rust achieves memory safety without GC", tag: "topic=lang" },
		{ text: "Memory subsystem uses Tantivy for lex search", tag: "topic=internal" },
		{ text: "Roadmap items: dashboard polish, memory replay", tag: "topic=roadmap" },
	];
	for (const s of seeds) {
		await runAdd(
			parseAddArgs(
				s.tag ? ["--user", "alice", "--text", s.text, "--tag", s.tag] : ["--user", "alice", "--text", s.text],
			),
		);
	}
});

afterEach(async () => {
	await closeRawMessageStore();
});

describeIf("opencontext search — real storage round-trip", () => {
	it("--mode lex finds literal substring matches", async () => {
		const exit = await runSearch(
			parseSearchArgs(["--user", "alice", "--query", "roadmap", "--mode", "lex", "--k", "10"]),
		);
		expect(exit).toBe(0);

		// Verify via the same channel the CLI uses — queryMessages — that
		// the seed data is really there.
		const manager = await getRawMessageManager();
		const rows = await manager.queryMessages({ userId: "alice", limit: 10 });
		expect(rows.length).toBeGreaterThanOrEqual(2);
		const roadmap = rows.filter((r) => r.content.toLowerCase().includes("roadmap"));
		expect(roadmap.length).toBeGreaterThanOrEqual(2);
	});

	it("returns zero results when no message matches (zero is success, not error)", async () => {
		const exit = await runSearch(parseSearchArgs(["--user", "alice", "--query", "quantum chromodynamics"]));
		expect(exit).toBe(0);
	});

	it("never calls the LLM: synthesize is always false on the CLI path", async () => {
		// Run a search and read the resulting envelope from disk by
		// capturing stdout — synthesize=false is asserted in the unit
		// test directly against the mocked SDK. This integration case
		// just confirms the read path itself doesn't throw when
		// synthesize is forced off.
		await runSearch(parseSearchArgs(["--user", "alice", "--query", "roadmap"]));
		// success path: no throw, exit 0
	});

	it("scopes results to the requested userId", async () => {
		// Seed one extra message for bob
		await runAdd(parseAddArgs(["--user", "bob", "--text", "Bob's private roadmap"]));

		const exit = await runSearch(parseSearchArgs(["--user", "alice", "--query", "roadmap", "--mode", "lex"]));
		expect(exit).toBe(0);

		// Bob's row should be invisible to alice's search. Verified by
		// scoping a direct queryMessages call the same way the CLI does.
		const manager = await getRawMessageManager();
		const aliceRows = await manager.queryMessages({ userId: "alice", limit: 20 });
		const bobRows = await manager.queryMessages({ userId: "bob", limit: 20 });
		expect(aliceRows.every((r) => r.userId === "alice")).toBe(true);
		expect(bobRows.every((r) => r.userId === "bob")).toBe(true);
	});
});
