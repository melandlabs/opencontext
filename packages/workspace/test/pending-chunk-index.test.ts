/**
 * The pending-chunk index.
 *
 * "Does this version still have a chunk without a vector?" is the question
 * the embedding queue asks after every job and the stalled-resource sweep
 * asks for every pending resource. The table used to be indexed on
 * `(workspace_id)` and `(resource_id, version_id)` only — neither of which
 * has `version_id` in front — so every answer was a scan of the whole
 * table, and the answer "yes, they are all embedded" is precisely the one
 * that has to look at every row.
 *
 * The index is partial: only the chunks that still wait for a vector are
 * indexed, so it stays small however large the table grows.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { WORKSPACE_POSTGRES_DDL } from "../src/postgres/schema";
import { SqliteWorkspaceStore } from "../src/sqlite";

const PENDING_INDEX = "idx_workspace_chunks_version_pending";

/**
 * The statement, in the shape both backends have to agree on.
 *
 * The Postgres DDL is a list of statements, so it is checked as text: the
 * Postgres side of the index is only executed against a live database,
 * and this keeps a typo in the DDL from reaching that far unnoticed.
 */
const PENDING_INDEX_PATTERN = new RegExp(
	`CREATE INDEX IF NOT EXISTS ${PENDING_INDEX}\\s+ON workspace_chunks\\s*\\(\\s*version_id\\s*,\\s*chunk_index\\s*\\)\\s*WHERE embedding IS NULL`,
);

function insertChunk(
	db: Database.Database,
	overrides: {
		chunk_id: string;
		version_id: number;
		chunk_index: number;
		embedded?: boolean;
	},
): void {
	db.prepare(
		`INSERT INTO workspace_chunks (
       chunk_id, resource_id, version_id, workspace_id, chunk_index, chunk_count,
       start_position, end_position, content, content_hash, embedding
     ) VALUES (?, 1, ?, 'w1', ?, 2, 0, 10, 'body', 'hash', ?)`,
	).run(
		overrides.chunk_id,
		overrides.version_id,
		overrides.chunk_index,
		overrides.embedded ? Buffer.from(new Float32Array([0.1, 0.2]).buffer) : null,
	);
}

describe("workspace_chunks — pending-chunk index", () => {
	it("carries the same index on Postgres", () => {
		// A store that moves from one backend to the other keeps the same
		// index under the same name — and the statement itself is checked
		// here, because the Postgres DDL only ever runs against a live
		// database.
		const ddl = WORKSPACE_POSTGRES_DDL.join("\n");
		expect(PENDING_INDEX_PATTERN.test(ddl)).toBe(true);
	});

	it("indexes the chunks that still wait for a vector", async () => {
		const db = new Database(":memory:");
		const store = new SqliteWorkspaceStore({ db });
		await store.init();
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workspace_chunks'")
			.all() as Array<{ name: string }>;
		expect(indexes.map((row) => row.name)).toContain(PENDING_INDEX);
		await store.close();
	});

	it("answers the pending-chunk question from the index instead of scanning", async () => {
		const db = new Database(":memory:");
		const store = new SqliteWorkspaceStore({ db });
		await store.init();
		insertChunk(db, { chunk_id: "c1", version_id: 7, chunk_index: 0 });
		insertChunk(db, { chunk_id: "c2", version_id: 7, chunk_index: 1, embedded: true });
		insertChunk(db, { chunk_id: "c3", version_id: 8, chunk_index: 0, embedded: true });

		const plan = db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT 1 FROM workspace_chunks WHERE version_id = ? AND embedding IS NULL LIMIT 1",
			)
			.all(7) as Array<{ detail: string }>;
		const detail = plan.map((row) => row.detail).join(" ");
		expect(detail).toContain(PENDING_INDEX);
		expect(detail).not.toContain("SCAN workspace_chunks");

		const batchPlan = db
			.prepare(
				`EXPLAIN QUERY PLAN SELECT id FROM workspace_chunks
         WHERE version_id = ? AND embedding IS NULL ORDER BY chunk_index LIMIT ?`,
			)
			.all(7, 100) as Array<{ detail: string }>;
		expect(batchPlan.map((row) => row.detail).join(" ")).toContain(PENDING_INDEX);
		await store.close();
	});

	it("keeps the index free of the chunks that already have a vector", async () => {
		const db = new Database(":memory:");
		const store = new SqliteWorkspaceStore({ db });
		await store.init();
		insertChunk(db, { chunk_id: "c1", version_id: 7, chunk_index: 0 });
		insertChunk(db, { chunk_id: "c2", version_id: 7, chunk_index: 1, embedded: true });

		const indexed = () =>
			db
				.prepare(
					`SELECT chunk_id FROM workspace_chunks INDEXED BY ${PENDING_INDEX}
           WHERE embedding IS NULL`,
				)
				.all() as Array<{ chunk_id: string }>;
		expect(indexed().map((row) => row.chunk_id)).toEqual(["c1"]);

		// The partial index holds the pending rows only: once the vector is
		// written the row leaves it, which is what keeps the index small.
		db.prepare("UPDATE workspace_chunks SET embedding = ? WHERE chunk_id = ?").run(
			Buffer.from(new Float32Array([0.1, 0.2]).buffer),
			"c1",
		);
		expect(indexed()).toEqual([]);
		await store.close();
	});

	it("answers the pending-chunk question for a whole batch in one statement", async () => {
		const db = new Database(":memory:");
		const store = new SqliteWorkspaceStore({ db });
		await store.init();
		insertChunk(db, { chunk_id: "c1", version_id: 7, chunk_index: 0 });
		insertChunk(db, { chunk_id: "c2", version_id: 7, chunk_index: 1, embedded: true });
		insertChunk(db, { chunk_id: "c3", version_id: 8, chunk_index: 0 });
		insertChunk(db, { chunk_id: "c4", version_id: 9, chunk_index: 0, embedded: true });

		// Version 7 still waits for a vector, version 8 does not, version 9
		// was never asked about.
		expect(store.filterVersionsWithPendingChunks([7, 8, 9])).toEqual([7, 8]);
		expect(store.filterVersionsWithPendingChunks([9])).toEqual([]);
		expect(store.filterVersionsWithPendingChunks([])).toEqual([]);
		await store.close();
	});

	it("splits a batch that is longer than SQLite allows in one statement", async () => {
		const db = new Database(":memory:");
		const store = new SqliteWorkspaceStore({ db });
		await store.init();
		const versionIds = Array.from({ length: 1200 }, (_, index) => index + 1);
		insertChunk(db, { chunk_id: "c1", version_id: 1, chunk_index: 0 });
		insertChunk(db, { chunk_id: "c2", version_id: 900, chunk_index: 0 });

		const found = store.filterVersionsWithPendingChunks(versionIds);
		expect(found.sort((a, b) => a - b)).toEqual([1, 900]);
		await store.close();
	});
});
