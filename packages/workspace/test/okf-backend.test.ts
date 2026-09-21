/**
 * Tests for `okf-backend.indexOkfFolder` — sha256 dedup, cites-edge
 * extraction, soft-delete detection across re-runs, and the mtime/size
 * reconcile fast path.
 */
import { mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OKF_MAX_EXTRACT_BYTES, indexOkfFolder } from "../src/okf-backend";
import { SqliteWorkspaceStore } from "../src/sqlite";

// Wrap the real extractor with a call counter so fast-path tests can
// assert extraction was skipped. The wrapper delegates to the actual
// implementation, so parsing behaviour is unchanged.
const { extractTextCalls } = vi.hoisted(() => ({ extractTextCalls: [] as string[] }));

vi.mock("../src/parsers-adapter", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/parsers-adapter")>();
	return {
		...actual,
		extractText: async (sourcePath: string, mimeType?: string) => {
			extractTextCalls.push(sourcePath);
			return actual.extractText(sourcePath, mimeType);
		},
	};
});

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

	it("writes cites edges from markdown links inside non-.md file bodies", async () => {
		// The docx body is the EXTRACTED plain text that parsers-adapter
		// returns for signed-addendum.docx — it contains a markdown link
		// pointing at ./law.md. The indexer should mine that link and
		// write a cites edge, even though buildGraphFromDir only sees
		// the raw .md files on disk.
		const okfRoot = join(scratchDir, "wiki2");
		mkdirSync(okfRoot, { recursive: true });
		writeFile(
			okfRoot,
			"law.md",
			"---\ntype: Statute\n---\n# Law\n\nCivil code article 123 is the controlling clause.\n",
		);
		writeFile(
			okfRoot,
			"signed-addendum.txt",
			"Public Law — Cap of Liability\n\nStatutory cap of liability is twelve months of fees.\nSee also [Limitation of Liability](./law.md).\n",
		);

		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store2.db") });
		await store.init();
		await indexOkfFolder(store, {
			workspace_id: "p2",
			user_id: "u2",
			path: okfRoot,
			enqueueEmbedding: async () => {},
		});

		const edgeRows = store.__testDb
			.prepare(
				`SELECT pr1.canonical_key AS source, pr2.canonical_key AS target, edge_type
                 FROM workspace_reference_edges e
                 JOIN workspace_resources pr1 ON pr1.id = e.source_resource_id
                 JOIN workspace_resources pr2 ON pr2.id = e.target_resource_id
                 WHERE edge_type = 'cites'`,
			)
			.all() as Array<{ source: string; target: string; edge_type: string }>;
		const txtToMd = edgeRows.find((row) => row.source === "signed-addendum.txt" && row.target === "law.md");
		expect(txtToMd).toBeDefined();
		expect(txtToMd?.edge_type).toBe("cites");
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

	it("skips dot-directories and dependency dirs during the walk", async () => {
		const okfRoot = join(scratchDir, "wiki");
		mkdirSync(okfRoot, { recursive: true });
		writeFile(okfRoot, "visible.md", "hello");
		writeFile(okfRoot, "deep/nested/visible2.md", "hello too");
		writeFile(okfRoot, "node_modules/pkg/README.md", "noise");
		writeFile(okfRoot, ".hidden/secret.md", "noise");
		writeFile(okfRoot, "venv/notes.md", "noise");
		writeFile(okfRoot, "__pycache__/cache.md", "noise");

		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const result = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async () => {},
		});
		expect(result.filesScanned).toBe(2);
		expect(result.filesAdded).toBe(2);
		const listed = store.listResources({ workspace_id: "p1", limit: 50 });
		expect(listed.resources.map((resource) => resource.canonical_key).sort()).toEqual([
			"deep/nested/visible2.md",
			"visible.md",
		]);
		await store.close();
	});

	it("honours extra ignoreDirNames on top of the defaults", async () => {
		const okfRoot = join(scratchDir, "wiki");
		mkdirSync(okfRoot, { recursive: true });
		writeFile(okfRoot, "keep.md", "keep");
		writeFile(okfRoot, "build/out.md", "generated noise");

		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const result = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async () => {},
			ignoreDirNames: new Set(["build"]),
		});
		expect(result.filesScanned).toBe(1);
		expect(result.filesAdded).toBe(1);
		await store.close();
	});

	it("exposes SUPPORTED_EXTENSIONS / resourceTypeForExtension / DEFAULT_IGNORED_DIR_NAMES from the barrel", async () => {
		const barrel = await import("../src/index");
		expect(barrel.SUPPORTED_EXTENSIONS.has(".md")).toBe(true);
		expect(barrel.SUPPORTED_EXTENSIONS.has(".doc")).toBe(false);
		expect(barrel.resourceTypeForExtension(".xlsx")).toBe("spreadsheet");
		expect(barrel.resourceTypeForExtension(".docx")).toBe("document");
		expect(barrel.DEFAULT_IGNORED_DIR_NAMES.has("node_modules")).toBe(true);
	});

	it("exposes OKF_MAX_EXTRACT_BYTES from the barrel", async () => {
		const barrel = await import("../src/index");
		expect(barrel.OKF_MAX_EXTRACT_BYTES).toBe(32 * 1024 * 1024);
	});

	it("skips extractText for unchanged files on the second reconcile (stat fast path)", async () => {
		const okfRoot = join(scratchDir, "wiki");
		mkdirSync(okfRoot, { recursive: true });
		writeFile(okfRoot, "a.md", "# A\n\nalpha body\n");
		writeFile(okfRoot, "b.md", "# B\n\nbravo body\n");

		extractTextCalls.length = 0;
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const first = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async () => {},
		});
		expect(first.filesAdded).toBe(2);
		expect(extractTextCalls.length).toBe(2);

		extractTextCalls.length = 0;
		const second = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async () => {},
		});
		expect(second.filesScanned).toBe(2);
		expect(second.filesAdded).toBe(0);
		expect(second.filesModified).toBe(0);
		expect(second.filesUnchanged).toBe(2);
		expect(second.filesDeleted).toBe(0);
		expect(extractTextCalls).toEqual([]);
		await store.close();
	});

	it("re-extracts when mtime or size changes (sha dedup still governs change_kind)", async () => {
		const okfRoot = join(scratchDir, "wiki");
		mkdirSync(okfRoot, { recursive: true });
		writeFile(okfRoot, "a.md", "# A\n\nalpha body\n");
		writeFile(okfRoot, "b.md", "# B\n\nbravo body\n");

		extractTextCalls.length = 0;
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const first = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async () => {},
		});
		expect(first.filesAdded).toBe(2);
		extractTextCalls.length = 0;

		// a.md: content identical, mtime bumped (touch) — the fast path no
		// longer trusts the stored mtime, so the file IS re-extracted; the
		// body sha then dedups it to "unchanged". b.md: content grows →
		// "modified".
		const future = new Date(Date.now() + 60_000);
		utimesSync(join(okfRoot, "a.md"), future, future);
		writeFile(okfRoot, "b.md", "# B\n\nbravo body, now much longer than before\n");

		const second = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async () => {},
		});
		expect(second.filesScanned).toBe(2);
		expect(second.filesAdded).toBe(0);
		expect(second.filesModified).toBe(1);
		expect(second.filesUnchanged).toBe(1);
		expect(extractTextCalls.length).toBe(2);
		expect(extractTextCalls.filter((path) => path.endsWith("a.md"))).toHaveLength(1);
		expect(extractTextCalls.filter((path) => path.endsWith("b.md"))).toHaveLength(1);
		await store.close();
	});

	it("trusts a same-length rewrite with a restored mtime (documented fast-path trade-off)", async () => {
		const okfRoot = join(scratchDir, "wiki");
		mkdirSync(okfRoot, { recursive: true });
		writeFile(okfRoot, "a.md", "original body content");
		// Pin mtime to an exact integer-ms value so it round-trips cleanly
		// through utimes + stat + JSON storage.
		const pinnedMtime = new Date(1_700_000_000_000);
		utimesSync(join(okfRoot, "a.md"), pinnedMtime, pinnedMtime);

		extractTextCalls.length = 0;
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const first = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async () => {},
		});
		expect(first.filesAdded).toBe(1);
		const resourceRow = store.__testDb
			.prepare("SELECT id FROM workspace_resources WHERE canonical_key = 'a.md'")
			.get() as { id: number };

		// Craft the undetectable edit: same byte length, mtime restored.
		writeFile(okfRoot, "a.md", "tampered body content");
		expect("tampered body content".length).toBe("original body content".length);
		utimesSync(join(okfRoot, "a.md"), pinnedMtime, pinnedMtime);

		extractTextCalls.length = 0;
		const second = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async () => {},
		});
		// Known trade-off (git/rsync-level): mtime+size hit ⇒ trusted. The
		// file is treated as unchanged and extraction is skipped.
		expect(second.filesUnchanged).toBe(1);
		expect(second.filesModified).toBe(0);
		expect(extractTextCalls).toEqual([]);

		// Stored body is still the original — the new content is not picked
		// up until mtime or size changes.
		const versionCount = store.__testDb
			.prepare("SELECT COUNT(*) AS count FROM workspace_resource_versions WHERE resource_id = ?")
			.get(resourceRow.id) as { count: number };
		expect(versionCount.count).toBe(1);
		const chunks = store.__testDb
			.prepare("SELECT content FROM workspace_chunks WHERE resource_id = ?")
			.all(resourceRow.id) as Array<{ content: string }>;
		expect(chunks.map((chunk) => chunk.content).join("")).toContain("original body content");
		await store.close();
	});

	it("skips files over OKF_MAX_EXTRACT_BYTES and soft-deletes them if previously indexed", async () => {
		const okfRoot = join(scratchDir, "wiki");
		mkdirSync(okfRoot, { recursive: true });
		writeFile(okfRoot, "small.txt", "tiny body");

		extractTextCalls.length = 0;
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const first = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async () => {},
		});
		expect(first.filesScanned).toBe(1);
		expect(first.filesAdded).toBe(1);

		// Grow the file past the cap. truncateSync creates a sparse file,
		// so the oversized body costs no real disk / CPU.
		truncateSync(join(okfRoot, "small.txt"), OKF_MAX_EXTRACT_BYTES + 1);
		extractTextCalls.length = 0;
		const second = await indexOkfFolder(store, {
			workspace_id: "p1",
			user_id: "u1",
			path: okfRoot,
			enqueueEmbedding: async () => {},
		});
		expect(second.filesScanned).toBe(0);
		expect(second.filesAdded).toBe(0);
		expect(second.filesDeleted).toBe(1);
		expect(extractTextCalls).toEqual([]);
		expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("small.txt"))).toBe(true);

		// The previously-indexed file is soft-deleted because the oversized
		// file never enters presentKeys — documented behaviour for the cap.
		const row = store.__testDb
			.prepare("SELECT metadata FROM workspace_resources WHERE canonical_key = 'small.txt'")
			.get() as { metadata: string | null };
		const meta = JSON.parse(row.metadata ?? "{}") as { deleted_at?: number };
		expect(typeof meta.deleted_at).toBe("number");

		warnSpy.mockRestore();
		await store.close();
	});
});
