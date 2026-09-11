/**
 * Tests for `SqliteWorkspaceStore` — schema bootstrap, resource/version
 * chain, sha256 dedup, unchanged short-circuit, and version parent
 * linkage.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteWorkspaceStore } from "../src/sqlite";
import type { OkfFolderResource } from "../src/types";

let scratchDir: string;

beforeEach(() => {
	scratchDir = mkdtempSync(join(tmpdir(), "workspace-store-"));
});

afterEach(() => {
	rmSync(scratchDir, { recursive: true, force: true });
});

function makeResource(overrides: Partial<OkfFolderResource> & Pick<OkfFolderResource, "canonical_key" | "body">): OkfFolderResource {
	return {
		absolute_path: `/fake/${overrides.canonical_key}`,
		title: overrides.canonical_key,
		resource_type: "note",
		size_bytes: overrides.body.length,
		...overrides,
	};
}

describe("SqliteWorkspaceStore", () => {
	it("initialises every schema table on init()", async () => {
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const tables = (store as unknown as { __testDb: { prepare: (s: string) => { all: () => unknown[] } } })
			.__testDb.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger')`)
			.all() as Array<{ name: string }>;
		const names = tables.map((row) => row.name);
		expect(names).toContain("workspace_resources");
		expect(names).toContain("workspace_resource_versions");
		expect(names).toContain("workspace_chunks");
		expect(names).toContain("workspace_chunks_fts");
		expect(names).toContain("workspace_reference_edges");
		expect(names).toContain("workspace_jobs");
		await store.close();
	});

	it("creates a resource + version + chunks on first indexResource", async () => {
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const result = await store.indexResource({
			workspace_id: "p1",
			user_id: "u1",
			resource: makeResource({
				canonical_key: "docs/intro.md",
				body: "Hello world. This is the first document for the project.",
			}),
		});
		expect(result.change_kind).toBe("created");
		expect(result.resource_id).toBeGreaterThan(0);
		const chunks = store.__testDb
			.prepare(`SELECT chunk_index, chunk_count, content FROM workspace_chunks ORDER BY chunk_index`)
			.all() as Array<{ chunk_index: number; chunk_count: number; content: string }>;
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0]?.chunk_count).toBe(chunks.length);
		await store.close();
	});

	it("short-circuits with change_kind='unchanged' on identical re-index", async () => {
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const body = "Identical body for sha256 dedup test.";
		const first = await store.indexResource({
			workspace_id: "p1",
			user_id: "u1",
			resource: makeResource({ canonical_key: "docs/notes.md", body }),
		});
		expect(first.change_kind).toBe("created");
		const second = await store.indexResource({
			workspace_id: "p1",
			user_id: "u1",
			resource: makeResource({ canonical_key: "docs/notes.md", body }),
		});
		expect(second.change_kind).toBe("unchanged");
		expect(second.version_id).toBe(first.version_id);
		await store.close();
	});

	it("creates a new version with parent_version_id on modified content", async () => {
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const first = await store.indexResource({
			workspace_id: "p1",
			user_id: "u1",
			resource: makeResource({ canonical_key: "docs/changelog.md", body: "version 1 body" }),
		});
		const second = await store.indexResource({
			workspace_id: "p1",
			user_id: "u1",
			resource: makeResource({ canonical_key: "docs/changelog.md", body: "version 2 body — modified!" }),
		});
		expect(second.change_kind).toBe("modified");
		expect(second.version_id).not.toBe(first.version_id);
		const versions = store.__testDb
			.prepare(`SELECT id, version_number, parent_version_id FROM workspace_resource_versions ORDER BY version_number`)
			.all() as Array<{ id: number; version_number: number; parent_version_id: number | null }>;
		expect(versions.length).toBe(2);
		expect(versions[1]?.parent_version_id).toBe(versions[0]?.id ?? null);
		await store.close();
	});

	it("soft-deletes missing resources when their canonical_key disappears", async () => {
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		await store.indexResource({
			workspace_id: "p1",
			user_id: "u1",
			resource: makeResource({ canonical_key: "docs/a.md", body: "alpha" }),
		});
		await store.indexResource({
			workspace_id: "p1",
			user_id: "u1",
			resource: makeResource({ canonical_key: "docs/b.md", body: "bravo" }),
		});
		const missing = store.softDeleteMissingResources({
			workspace_id: "p1",
			presentKeys: new Set(["docs/a.md"]),
		});
		expect(missing.map((entry) => entry.canonical_key)).toEqual(["docs/b.md"]);
		const afterRows = store.__testDb
			.prepare(`SELECT canonical_key, metadata FROM workspace_resources ORDER BY canonical_key`)
			.all() as Array<{ canonical_key: string; metadata: string | null }>;
		const deletedRow = afterRows.find((row) => row.canonical_key === "docs/b.md");
		expect(deletedRow).toBeDefined();
		const meta = JSON.parse(deletedRow?.metadata ?? "{}") as { deleted_at?: number };
		expect(typeof meta.deleted_at).toBe("number");
		await store.close();
	});

	it("reuses init() safely across multiple new instances on the same DB", async () => {
		const dbPath = join(scratchDir, "store.db");
		const first = new SqliteWorkspaceStore({ dbPath });
		await first.init();
		await first.close();
		const second = new SqliteWorkspaceStore({ dbPath });
		await expect(second.init()).resolves.toBeUndefined();
		await second.close();
	});
});
