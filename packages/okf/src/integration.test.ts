/**
 * Integration test for the OKF v0.2 package.
 *
 * End-to-end:
 *   1. Build a fixture package in a tmpdir.
 *   2. Ingest it via `startOkf({ action: "ingest", ... })`.
 *   3. Query the memory store for the user.
 *   4. Emit a Knowledge Package to a second tmpdir.
 *   5. Validate the emitted package yields zero issues.
 *
 * The memory-store backend is the default SQLite (`createRawMessageStore({})`).
 * The test cleans up after itself.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startOkf } from "./cli.js";
import { readOkfPackage, writeOkfPackage } from "./package.js";

// Lazy memory-store loader. See the matching helper in `cli.ts` for the
// rationale (workspace cycle between `okf` and `memory-store`).
type MemoryStoreModule = typeof import("@melandlabs/memory-store");
let cachedMemoryStore: MemoryStoreModule | undefined;
async function loadMemoryStore(): Promise<MemoryStoreModule> {
	if (!cachedMemoryStore) {
		cachedMemoryStore = await import("@melandlabs/memory-store");
	}
	return cachedMemoryStore;
}

let tmpDir: string;
const originalDbPath = process.env.MEMORY_STORE_DB_PATH;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "okf-integration-"));
	// Point the default SQLite backend at a scratch file inside tmpDir so
	// each test sees a fresh database and does not write to the user's
	// ~/.opencontext/memory/store.db. Without this, the singleton would
	// accumulate rows across runs and the row-count assertions below
	// would drift.
	process.env.MEMORY_STORE_DB_PATH = join(tmpDir, "store.db");
});

afterEach(async () => {
	// Restore env first so the close below doesn't accidentally reopen
	// the just-deleted scratch file.
	if (originalDbPath === undefined) {
		process.env.MEMORY_STORE_DB_PATH = undefined;
	} else {
		process.env.MEMORY_STORE_DB_PATH = originalDbPath;
	}
	// Always close the singleton so successive tests start fresh.
	await (await loadMemoryStore()).closeRawMessageStore().catch(() => undefined);
	await rm(tmpDir, { recursive: true, force: true });
});

const FIXTURE_USER = `u-integration-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const documents = [
	{
		path: "Reference/acronym.md",
		text: `---
type: Reference
title: Project Acronym
description: OKF and its expansion
generated: { by: test, at: "2026-08-19T10:00:00Z" }
tags: [acronym, project]
sources:
  - resource: https://example.com/spec
verified:
  - by: reviewer
    at: "2026-08-19T10:00:00Z"
---

OKF = Open Knowledge Format.
`,
	},
	{
		path: "Experience/reading.md",
		text: `---
type: Experience
title: Reading the OKF spec
generated: { by: test, at: "2026-08-19T10:00:00Z" }
---

I read the OKF spec on 2026-08-19.
`,
	},
	{
		path: "Opinion/opinion.md",
		text: `---
type: Opinion
title: OKF is well-designed
generated: { by: test, at: "2026-08-19T10:00:00Z" }
---

OKF is well-designed.
`,
	},
];

async function writeFixture(dir: string): Promise<void> {
	for (const doc of documents) {
		const fullPath = join(dir, doc.path);
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(fullPath, doc.text, "utf8");
	}
}

describe("OKF end-to-end", () => {
	it("ingests a fixture, emits a package, validates the emitted package", async () => {
		// 1. Build a fixture package.
		const inputDir = join(tmpDir, "input");
		await writeFixture(inputDir);

		// 2. Ingest it.
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const ingestResult = await startOkf({
				action: "ingest",
				dir: inputDir,
				user: FIXTURE_USER,
				json: true,
			});
			expect(ingestResult.ok).toBe(true);
			const ingestOutput = JSON.parse(log.mock.calls[0]?.[0] as string);
			expect(ingestOutput.summary.ingested).toBe(3);
			expect(ingestOutput.summary.issues).toBe(0);
		} finally {
			log.mockRestore();
			warn.mockRestore();
		}

		// 3. Query the memory store directly.
		const store = (await loadMemoryStore()).createRawMessageStore({});
		const manager = await store.getManager();
		const rows = (await manager.queryMessages({
			userId: FIXTURE_USER,
			limit: 100,
		})) as Array<{ messageId: string; content: string; metadata: Record<string, unknown>; factType: string }>;
		await store.close();
		expect(rows.length).toBe(3);
		const types = rows.map((r) => r.factType).sort();
		expect(types).toEqual(["experience", "mental_model", "world"]);

		// 4. Emit a Knowledge Package.
		const outputDir = join(tmpDir, "output");
		const emitStore = (await loadMemoryStore()).createRawMessageStore({});
		const emitManager = await emitStore.getManager();
		const emitRows = (await emitManager.queryMessages({
			userId: FIXTURE_USER,
			limit: 100,
		})) as Array<import("@melandlabs/indexeddb").RawMessage>;
		const writeResult = await writeOkfPackage(outputDir, emitRows, {
			userIds: [FIXTURE_USER],
			packageVersion: "1.0.0",
		});
		await emitStore.close();
		expect(writeResult.written).toBe(3);

		// Layout: <Type>/<slug>.md
		// The slug is derived from `slugify(type + "-" + firstLine(body))`.
		const expectedLayout = [
			"Reference/reference-okf-open-knowledge-format.md",
			"Experience/experience-i-read-the-okf-spec-on-2026-08-19.md",
			"Opinion/opinion-okf-is-well-designed.md",
		];
		for (const rel of expectedLayout) {
			const fullPath = join(outputDir, rel);
			const s = await stat(fullPath);
			expect(s.isFile()).toBe(true);
		}

		// Manifest exists with the expected counts.
		const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8"));
		expect(manifest.okfConceptCount).toBe(3);
		expect(manifest.userIds).toContain(FIXTURE_USER);

		// 5. Validate the emitted package — zero issues.
		const back = await readOkfPackage(outputDir);
		const validationErrors = back.files.flatMap((f) => f.issues.filter((i) => i.code !== "missing_type"));
		const missingType = back.files.filter((f) => f.issues.some((i) => i.code === "missing_type"));
		expect(missingType).toEqual([]);
		expect(validationErrors).toEqual([]);
	});

	it("round-trip: emit → re-ingest produces equivalent facts", async () => {
		// Initial ingest.
		const inputDir = join(tmpDir, "input");
		await writeFixture(inputDir);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await startOkf({
				action: "ingest",
				dir: inputDir,
				user: FIXTURE_USER,
				json: true,
				continueOnError: true,
			});
		} finally {
			log.mockRestore();
			warn.mockRestore();
		}

		// Capture the originals.
		let before: Array<{ messageId: string; content: string; timestamp: number; factType: string }>;
		{
			const store = (await loadMemoryStore()).createRawMessageStore({});
			const manager = await store.getManager();
			before = (await manager.queryMessages({
				userId: FIXTURE_USER,
				limit: 100,
			})) as typeof before;
			await store.close();
		}

		// Emit.
		const outputDir = join(tmpDir, "output");
		const store = (await loadMemoryStore()).createRawMessageStore({});
		const manager = await store.getManager();
		const rows = (await manager.queryMessages({
			userId: FIXTURE_USER,
			limit: 100,
		})) as Array<import("@melandlabs/indexeddb").RawMessage>;
		await writeOkfPackage(outputDir, rows, { packageVersion: "1.0.0" });
		await store.close();

		// Re-ingest into the same user. The per-test scratch DB
		// (`MEMORY_STORE_DB_PATH` reset in beforeEach) already isolates
		// singleton state between cases. The codec honours `fm.resource`
		// (which we wrote on emit) so the re-ingested messageIds match
		// the originals; the SQLite store's scope conflict only fires
		// when the same messageId carries a different userId, and we
		// explicitly use one user here so the upsert is in place.
		const reIngestUser = FIXTURE_USER;
		const log2 = vi.spyOn(console, "log").mockImplementation(() => {});
		const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await startOkf({
				action: "ingest",
				dir: outputDir,
				user: reIngestUser,
				json: true,
				continueOnError: true,
			});
		} finally {
			log2.mockRestore();
			warn2.mockRestore();
		}

		// Compare.
		const storeAfter = (await loadMemoryStore()).createRawMessageStore({});
		const managerAfter = await storeAfter.getManager();
		const after = (await managerAfter.queryMessages({
			userId: reIngestUser,
			limit: 100,
		})) as typeof before;
		await storeAfter.close();

		expect(after.length).toBe(before.length);
		const sortedBefore = [...before].sort((a, b) => a.messageId.localeCompare(b.messageId));
		const sortedAfter = [...after].sort((a, b) => a.messageId.localeCompare(b.messageId));
		for (let i = 0; i < sortedBefore.length; i += 1) {
			expect(sortedAfter[i]?.content).toBe(sortedBefore[i]?.content);
			expect(sortedAfter[i]?.timestamp).toBe(sortedBefore[i]?.timestamp);
			expect(sortedAfter[i]?.factType).toBe(sortedBefore[i]?.factType);
			expect(sortedAfter[i]?.messageId).toBe(sortedBefore[i]?.messageId);
		}
	});
});
