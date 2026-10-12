import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspaceCitation, searchWorkspaceContext, updateWorkspaceContext } from "../src/api";
import { SqliteWorkspaceStore } from "../src/sqlite";

describe("Chinese file evidence without embeddings", () => {
	let directory: string;
	let store: SqliteWorkspaceStore;
	let database: Database.Database;
	const context = { user_id: "alice", request_id: "test" };
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "workspace-chinese-"));
		database = new Database(join(directory, "index.db"));
		store = new SqliteWorkspaceStore({ db: database });
		await store.init();
	});
	afterEach(async () => {
		await store.close();
		database.close();
		rmSync(directory, { recursive: true, force: true });
	});
	it("finds a Chinese substring and reads its original file citation", async () => {
		writeFileSync(join(directory, "notes.md"), "项目代码使用 TypeScript。设计搭档是 Ava。", "utf8");
		await updateWorkspaceContext(context, store, {
			workspace_id: "personal:alice",
			source: "okf_folder",
			path: directory,
		});
		const result = await searchWorkspaceContext(
			context,
			store,
			{
				workspace_id: "personal:alice",
				query: "代码",
				strategy: "hybrid",
			},
			{
				embed: async () => {
					throw new Error("Embedding disabled");
				},
			},
		);
		expect(result.hits).toHaveLength(1);
		const citation = result.hits[0]!.citation;
		expect(citation).toMatchObject({ canonical_key: "notes.md", version_id: expect.any(Number) });
		expect(
			await resolveWorkspaceCitation(context, store, { workspace_id: "personal:alice", citation }),
		).toMatchObject({ status: "resolved", content: expect.stringContaining("项目代码") });
	});
	it("filters allowed resource identities before applying the lexical result limit", async () => {
		writeFileSync(join(directory, "one.md"), "付款期限为十天。", "utf8");
		writeFileSync(join(directory, "two.md"), "付款期限为二十天。", "utf8");
		await updateWorkspaceContext(context, store, {
			workspace_id: "knowledge:alice",
			source: "okf_folder",
			path: directory,
		});
		const input = { workspace_id: "knowledge:alice", user_id: "alice", query: "付款期限", limit: 1 };
		const selected = store.searchLexical({ ...input, canonical_keys: ["two.md"] });
		expect(selected).toHaveLength(1);
		expect(selected[0]?.canonical_key).toBe("two.md");
		expect(
			store.searchLexical({
				...input,
				canonical_keys: [...Array.from({ length: 40_000 }, (_, index) => `absent-${index}`), "two.md"],
			})[0]?.canonical_key,
		).toBe("two.md");
		expect(store.searchLexical({ ...input, canonical_keys: [] })).toEqual([]);
		expect(store.searchLexical({ ...input, user_id: "bob", canonical_keys: ["two.md"] })).toEqual([]);
	});
	it("does not manufacture a Chinese phrase across punctuation", async () => {
		writeFileSync(join(directory, "notes.md"), "项目代，代码。API项目使用 TypeScript。", "utf8");
		await updateWorkspaceContext(context, store, {
			workspace_id: "personal:alice",
			source: "okf_folder",
			path: directory,
		});
		const query = (text: string) =>
			searchWorkspaceContext(context, store, {
				workspace_id: "personal:alice",
				query: text,
				strategy: "lexical",
			});
		expect((await query("项目代码")).hits).toEqual([]);
		expect((await query("API项目")).hits).toHaveLength(1);
		expect((await query("项目使用")).hits).toHaveLength(1);
	});
	it("keeps an old citation missing after a new version replaces its chunks", async () => {
		const file = join(directory, "notes.md");
		writeFileSync(file, "设计搭档是 Ava。", "utf8");
		const input = { workspace_id: "personal:alice", source: "okf_folder" as const, path: directory };
		await updateWorkspaceContext(context, store, input);
		const first = await searchWorkspaceContext(context, store, {
			workspace_id: input.workspace_id,
			query: "搭档",
			strategy: "lexical",
		});
		const citation = first.hits[0]!.citation;
		writeFileSync(file, "设计搭档现在是 Bob，已经明确修订。", "utf8");
		await updateWorkspaceContext(context, store, input);
		expect(
			await resolveWorkspaceCitation(context, store, { workspace_id: input.workspace_id, citation }),
		).toMatchObject({ status: "missing", reason: "chunk_not_found" });
		const current = await searchWorkspaceContext(context, store, {
			workspace_id: input.workspace_id,
			query: "搭档",
			strategy: "lexical",
		});
		expect(current.hits[0]!.snippet).toContain("Bob");
		expect(current.hits[0]!.citation.version_id).not.toBe(citation.version_id);
		unlinkSync(file);
		await updateWorkspaceContext(context, store, input);
		expect(
			await resolveWorkspaceCitation(context, store, { citation: current.hits[0]!.citation }),
		).toMatchObject({ status: "missing" });
	});
	it("does not search or read another user's file even with its workspace and citation", async () => {
		writeFileSync(join(directory, "notes.md"), "项目代码属于 Alice。", "utf8");
		await updateWorkspaceContext(context, store, {
			workspace_id: "personal:alice",
			source: "okf_folder",
			path: directory,
		});
		const input = { workspace_id: "personal:alice", query: "代码", strategy: "lexical" as const };
		const own = await searchWorkspaceContext(context, store, input);
		const other = { user_id: "bob", request_id: "other" };
		expect((await searchWorkspaceContext(other, store, input)).hits).toEqual([]);
		expect(await resolveWorkspaceCitation(other, store, { citation: own.hits[0]!.citation })).toMatchObject({
			status: "missing",
		});
	});
	it("upgrades a legacy lexical index without changing source or citation identity", async () => {
		writeFileSync(join(directory, "notes.md"), "项目代码使用 TypeScript。", "utf8");
		await updateWorkspaceContext(context, store, {
			workspace_id: "personal:alice",
			source: "okf_folder",
			path: directory,
		});
		const before = await searchWorkspaceContext(context, store, {
			workspace_id: "personal:alice",
			query: "TypeScript",
			strategy: "lexical",
		});
		// Recreate the v2 on-disk index at the database boundary.
		database.exec(`
      DROP TABLE workspace_schema_migrations;
      DROP TRIGGER workspace_chunks_ai;
      DROP TRIGGER workspace_chunks_ad;
      DROP TRIGGER workspace_chunks_au;
      DROP TABLE workspace_chunks_fts;
      CREATE VIRTUAL TABLE workspace_chunks_fts USING fts5(content, content='workspace_chunks', content_rowid='id');
      INSERT INTO workspace_chunks_fts(workspace_chunks_fts) VALUES('rebuild');
    `);
		await store.close();
		database.close();
		database = new Database(join(directory, "index.db"));
		store = new SqliteWorkspaceStore({ db: database });
		await store.init();
		const after = await searchWorkspaceContext(context, store, {
			workspace_id: "personal:alice",
			query: "代码",
			strategy: "lexical",
		});
		expect(after.hits[0]!.citation).toMatchObject({
			id: before.hits[0]!.citation.id,
			content_hash: before.hits[0]!.citation.content_hash,
			version_id: before.hits[0]!.citation.version_id,
		});
		await store.init();
		expect(
			(
				await searchWorkspaceContext(context, store, {
					workspace_id: "personal:alice",
					query: "代码",
					strategy: "lexical",
				})
			).hits,
		).toHaveLength(1);
	});
	it("keeps cross-file expansion inside the requesting user's resources", async () => {
		writeFileSync(join(directory, "notes.md"), "项目代码属于 Alice。", "utf8");
		await updateWorkspaceContext(context, store, {
			workspace_id: "shared",
			source: "okf_folder",
			path: directory,
		});
		const own = await searchWorkspaceContext(context, store, {
			workspace_id: "shared",
			query: "代码",
			strategy: "lexical",
		});
		const other = await store.indexResource({
			workspace_id: "shared",
			user_id: "bob",
			resource: {
				canonical_key: "bob.md",
				absolute_path: "/bob.md",
				title: "Bob",
				body: "Bob's private context",
				size_bytes: 21,
				resource_type: "note",
			},
		});
		store.upsertReferenceEdges({
			workspace_id: "shared",
			edges: [
				{
					source_resource_id: own.hits[0]!.resource_id,
					source_version_id: own.hits[0]!.version_id,
					target_resource_id: other.resource_id,
					target_version_id: other.version_id,
					edge_type: "cites",
				},
			],
		});
		const result = await searchWorkspaceContext(
			context,
			store,
			{
				workspace_id: "shared",
				query: "代码",
				strategy: "cross-file",
			},
			{ embed: async () => new Array(1536).fill(0) },
		);
		expect(result.hits.map((hit) => hit.canonical_key)).toEqual(["notes.md"]);
	});
});
