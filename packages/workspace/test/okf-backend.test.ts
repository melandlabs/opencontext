/**
 * Tests for `okf-backend.indexOkfFolder` — sha256 dedup, cites-edge
 * extraction, and soft-delete detection across re-runs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { indexOkfFolder } from "../src/okf-backend";
import { SqliteWorkspaceStore } from "../src/sqlite";

let scratchDir: string;

beforeEach(() => {
	scratchDir = mkdtempSync(join(tmpdir(), "workspace-okf-"));
});

afterEach(() => {
	rmSync(scratchDir, { recursive: true, force: true });
});

function writeFile(folder: string, relativePath: string, content: string): void {
	const absolute = join(folder, relativePath);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, content, "utf8");
}

describe("indexOkfFolder", () => {
	it("indexes every .md file, computes sha256 dedup, and persists cites edges", async () => {
		const okfRoot = join(scratchDir, "wiki");
		mkdirSync(okfRoot, { recursive: true });
		writeFile(
			okfRoot,
			"contract.md",
			"---\ntype: Reference\n---\n# Contract\n\nSee [law](./law.md) for the governing provision.\n",
		);
		writeFile(
			okfRoot,
			"law.md",
			"---\ntype: Reference\n---\n# Law\n\nCivil code article 123 is the controlling clause.\n",
		);
		writeFile(
			okfRoot,
			"policy.md",
			"---\ntype: Reference\n---\n# Policy\n\nThis policy is not linked from any other document.\n",
		);

		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const enqueued: Array<{ resource_id: number; version_id: number }> = [];
		const result = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async (input) => {
				enqueued.push({ resource_id: input.resource_id, version_id: input.version_id });
			},
		});
		expect(result.filesScanned).toBe(3);
		expect(result.filesAdded).toBe(3);
		expect(result.filesModified).toBe(0);
		expect(result.filesUnchanged).toBe(0);
		expect(enqueued.length).toBe(3);
		// Re-run: every file should be unchanged.
		const second = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async () => {},
		});
		expect(second.filesScanned).toBe(3);
		expect(second.filesAdded).toBe(0);
		expect(second.filesModified).toBe(0);
		expect(second.filesUnchanged).toBe(3);
		// Cites edge: contract → law.
		const edgeRows = store.__testDb
			.prepare(
				`SELECT pr1.canonical_key AS source, pr2.canonical_key AS target, edge_type
                 FROM workspace_reference_edges e
                 JOIN workspace_resources pr1 ON pr1.id = e.source_resource_id
                 JOIN workspace_resources pr2 ON pr2.id = e.target_resource_id
                 WHERE edge_type = 'cites'`,
			)
			.all() as Array<{ source: string; target: string; edge_type: string }>;
		const contractLaw = edgeRows.find((row) => row.source === "contract.md" && row.target === "law.md");
		expect(contractLaw).toBeDefined();
		await store.close();
	});

	it("soft-deletes a resource whose file disappeared on a re-run", async () => {
		const okfRoot = join(scratchDir, "wiki");
		mkdirSync(okfRoot, { recursive: true });
		writeFile(okfRoot, "keep.md", "keep me");
		writeFile(okfRoot, "drop.md", "delete me next run");
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const first = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async () => {},
		});
		expect(first.filesAdded).toBe(2);
		rmSync(join(okfRoot, "drop.md"));
		const second = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async () => {},
		});
		expect(second.filesDeleted).toBe(1);
		const rows = store.__testDb
			.prepare("SELECT canonical_key, metadata FROM workspace_resources ORDER BY canonical_key")
			.all() as Array<{ canonical_key: string; metadata: string | null }>;
		const dropped = rows.find((row) => row.canonical_key === "drop.md");
		expect(dropped).toBeDefined();
		const meta = JSON.parse(dropped?.metadata ?? "{}") as { deleted_at?: number };
		expect(typeof meta.deleted_at).toBe("number");
		await store.close();
	});
});
