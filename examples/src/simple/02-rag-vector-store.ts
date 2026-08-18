/**
 * demo: @melandlabs/rag — SQLiteVecStore (local vector search).
 *
 * `SQLiteVecStore` gives you vector search with no external service: it
 * opens a plain SQLite file and loads the `sqlite-vec` extension, which
 * adds a `vec0` virtual table supporting KNN queries over float vectors.
 *
 * Two native pieces are involved — `better-sqlite3` (a compiled binding)
 * and `sqlite-vec` (a loadable extension). Either can be unavailable on
 * an unusual platform, so the whole section skips rather than fails.
 *
 * `addChunk()` writes chunk rows through Drizzle and into the vec0
 * table. In a real host app, the `rag_chunks` / `rag_documents` tables
 * are part of the host's own Drizzle schema, so this demo builds a
 * minimal version of those tables on the fly with
 * `drizzle-orm/sqlite-core` so the write path can actually run.
 */

import * as path from "node:path";
import Database from "better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { info, makeCheckWithSkip, runSection, withTmp } from "../_helpers.ts";

/** Embeddings are 1536-dimensional (OpenAI text-embedding-3-small). */
const DIMENSIONS = 1536;

function unitVector(hot: number): number[] {
	return Array.from({ length: DIMENSIONS }, (_, i) => (i === hot ? 1 : 0));
}

/**
 * Minimal Drizzle schema that matches the `SchemaModule` shape
 * `SQLiteVecStore` expects from a host application. In a real app the
 * host would already have `rag_chunks` / `rag_documents` as part of
 * their own Drizzle schema; here we synthesise one in-memory and
 * create the matching tables with raw SQL since the demo doesn't own
 * a Drizzle migration pipeline.
 */
const ragChunksTable = sqliteTable("rag_chunks", {
	id: text("id").primaryKey(),
	documentId: text("documentId").notNull(),
	userId: text("userId"),
	content: text("content"),
	embedding: text("embedding"),
	metadata: text("metadata"),
	chunkIndex: integer("chunkIndex"),
});

const ragDocumentsTable = sqliteTable("rag_documents", {
	id: text("id").primaryKey(),
	documentId: text("documentId").notNull(),
	userId: text("userId"),
	fileName: text("fileName"),
});

/**
 * Create the `rag_chunks` and `rag_documents` tables on the same SQLite
 * file `SQLiteVecStore` is about to open. The shape has to match the
 * `sqliteTable(...)` definitions above column-for-column so Drizzle's
 * INSERT in `addChunk` lands on real columns.
 */
function provisionHostSchemaTables(dbPath: string): void {
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	db.exec(`
        CREATE TABLE IF NOT EXISTS rag_chunks (
            id TEXT PRIMARY KEY,
            documentId TEXT NOT NULL,
            userId TEXT,
            content TEXT,
            embedding TEXT,
            metadata TEXT,
            chunkIndex INTEGER
        );
        CREATE TABLE IF NOT EXISTS rag_documents (
            id TEXT PRIMARY KEY,
            documentId TEXT NOT NULL,
            userId TEXT,
            fileName TEXT
        );
    `);
	db.close();
}

export default async function demoRagVectorStore() {
	await runSection("demo: @melandlabs/rag (SQLiteVecStore)", async () => {
		const { check, skip } = makeCheckWithSkip("demo/rag-vec");

		let SQLiteVecStore: typeof import("@melandlabs/rag").SQLiteVecStore;
		try {
			({ SQLiteVecStore } = await import("@melandlabs/rag"));
		} catch (err) {
			skip("SQLiteVecStore", "@melandlabs/rag failed to load", (err as Error).message);
			return;
		}

		await withTmp("rag-vec", async (dir) => {
			const dbPath = path.join(dir, "vectors.db");
			info("demo/rag-vec", `opening a fresh sqlite database at ${path.basename(dbPath)}`);

			// Stand up the host-side tables *before* SQLiteVecStore opens
			// the file, so the Drizzle INSERT in addChunk has somewhere
			// to land.
			provisionHostSchemaTables(dbPath);

			const schemaModule = {
				ragChunks: ragChunksTable,
				ragDocuments: ragDocumentsTable,
				InsertRAGChunk: {},
				InsertRAGDocument: {},
			} as unknown as import("@melandlabs/rag").SchemaModule;

			let store: InstanceType<typeof SQLiteVecStore>;
			try {
				store = new SQLiteVecStore(dbPath, schemaModule);
			} catch (err) {
				skip(
					"open SQLiteVecStore",
					"better-sqlite3 / sqlite-vec native module unavailable",
					(err as Error).message,
				);
				return;
			}

			try {
				// Searching an empty store is a real KNN query against vec0 —
				// it exercises the extension, the table, and the vector
				// serialisation, and correctly finds nothing.
				const results = await store.similaritySearch(unitVector(0), 3);
				info("demo/rag-vec", `similaritySearch on an empty store returned ${results.length} result(s)`);
				check(
					"similaritySearch against an empty store returns an empty array",
					Array.isArray(results) && results.length === 0,
					`${results.length} results`,
				);

				// A different query vector is still a valid query.
				const other = await store.similaritySearch(unitVector(42), 1);
				check("a second query with a different vector also succeeds", Array.isArray(other));

				// ── Write path: two chunks, then a populated similaritySearch ──
				// `addChunk` previously crashed with `Cannot read properties
				// of undefined (reading 'insert')` because the constructor
				// kicked off `initDrizzle` without awaiting it. v0.1.5 of
				// @melandlabs/rag fixes that plus two related bugs.
				await store.addChunk({
					id: "chunk-1",
					documentId: "doc-1",
					content: "OpenContext bundles retrieval, memory, scheduling, and integrations.",
					embedding: unitVector(0),
				});
				await store.addChunk({
					id: "chunk-2",
					documentId: "doc-1",
					content: "The pipeline is: chunk, embed, store, then search.",
					embedding: unitVector(7),
				});
				check("addChunk stores two chunks without throwing", true, "2 inserts OK");

				const populated = await store.similaritySearch(unitVector(0), 5);
				info(
					"demo/rag-vec",
					`populated similaritySearch returned ${populated.length} hit(s) for a unit(0) query`,
				);
				check(
					"populated similaritySearch returns at least one hit",
					Array.isArray(populated) && populated.length >= 1,
					`${populated.length} hit(s)`,
				);
				check(
					"the top hit is the chunk whose unit vector matches the query (chunk-1)",
					populated[0]?.id === "chunk-1",
					`top.id=${populated[0]?.id ?? "<none>"}`,
				);
			} finally {
				store.close();
			}

			// The database file really exists on disk before withTmp removes it.
			const { stat } = await import("node:fs/promises");
			const size = (await stat(dbPath)).size;
			info("demo/rag-vec", `sqlite file on disk is ${size} bytes`);
			check("the store wrote a real sqlite file to disk", size > 0, `${size} bytes`);
		});
	});
}
