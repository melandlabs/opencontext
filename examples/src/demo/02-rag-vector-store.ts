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
 * Note on writes: `addChunk()` persists chunk rows through Drizzle and
 * therefore needs the *host application's* real schema module (the
 * `SchemaModule` constructor argument). A standalone example has no such
 * schema, so this demo covers the parts that stand alone — opening the
 * store, the vec0 table it provisions, and querying it.
 */

import * as path from "node:path";
import { info, makeCheckWithSkip, runSection, withTmp } from "../_helpers.ts";

/** Embeddings are 1536-dimensional (OpenAI text-embedding-3-small). */
const DIMENSIONS = 1536;

function unitVector(hot: number): number[] {
	return Array.from({ length: DIMENSIONS }, (_, i) => (i === hot ? 1 : 0));
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

			// The host app normally passes its Drizzle schema here; the
			// vec0 table below is provisioned by the store itself.
			const schemaModule = {
				ragChunks: {},
				ragDocuments: {},
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

				skip(
					"addChunk + populated similaritySearch",
					"addChunk writes through Drizzle and needs the host app's real schema module",
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
