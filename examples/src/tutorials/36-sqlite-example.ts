/**
 * Tutorial: SQLite raw-message storage and lexical search.
 *
 * This example demonstrates the public surface of `@melandlabs/sqlite`:
 *
 *   - `SQLiteRawMessageManager` — a better-sqlite3-backed implementation of the
 *     raw message storage manager.
 *   - `lexicalSearchMessages` — BM25 keyword search over stored messages via
 *     the built-in FTS5 virtual table.
 *   - `floatArrayToBuffer` / `bufferToFloatArray` — utility helpers for moving
 *     float embeddings in and out of SQLite BLOB columns.
 *
 * A temporary database is created under `os.tmpdir()` and deleted when the
 * example finishes, so no persistent state is left behind.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/36-sqlite-example.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { runIfMain } from "../_helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SQLiteRawMessageManager,
	bufferToFloatArray,
	floatArrayToBuffer,
	type RawMessage,
} from "@melandlabs/sqlite";

function makeMessage(overrides: Partial<RawMessage> & { messageId: string; content: string }): RawMessage {
	const now = Math.floor(Date.now() / 1000);
	return {
		platform: "tutorial",
		botId: "bot-1",
		userId: "u1",
		timestamp: now,
		createdAt: now,
		...overrides,
	};
}

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- SQLiteRawMessageManager is a class: ${typeof SQLiteRawMessageManager === "function"}`);
	console.log(`- floatArrayToBuffer is callable: ${typeof floatArrayToBuffer === "function"}`);
	console.log(`- bufferToFloatArray is callable: ${typeof bufferToFloatArray === "function"}`);

	// ---- Buffer round-trip ----
	console.log("\n--- Embedding buffer round-trip ---");
	const embedding = [0.1, 0.2, 0.3, 0.4];
	const buffer = floatArrayToBuffer(embedding);
	if (!buffer || buffer.length === 0) {
		throw new Error("floatArrayToBuffer returned an empty buffer");
	}
	const restored = bufferToFloatArray(buffer);
	console.log(`original: ${embedding.join(", ")}`);
	console.log(`restored: ${restored?.join(", ")}`);
	if (!restored || restored.length !== embedding.length) {
		throw new Error("bufferToFloatArray did not restore the original embedding length");
	}
	for (let i = 0; i < embedding.length; i += 1) {
		if (Math.abs((restored[i] ?? 0) - embedding[i]!) > 0.0001) {
			throw new Error(`Restored embedding mismatch at index ${i}`);
		}
	}

	// ---- SQLite manager: init, insert, lexical search ----
	console.log("\n--- SQLiteRawMessageManager lexical search ---");
	const scratchDir = mkdtempSync(join(tmpdir(), "oc-sqlite-tutorial-"));
	const dbPath = join(scratchDir, "messages.db");
	const manager = new SQLiteRawMessageManager({ dbPath });
	await manager.init();

	try {
		await manager.storeMessages([
			makeMessage({ messageId: "m-alpha", content: "the quick brown fox jumps over the lazy dog" }),
			makeMessage({ messageId: "m-beta", content: "beta is the second greek letter and rare in english" }),
			makeMessage({ messageId: "m-gamma", content: "gamma rays are high-energy photons" }),
		]);

		const hits = await manager.lexicalSearchMessages({
			userId: "u1",
			keywords: ["beta"],
		});

		console.log(`lexical search returned ${hits.length} hit(s)`);
		for (const hit of hits) {
			console.log(`- ${hit.id}: ${hit.content.slice(0, 60)} (similarity=${hit.similarity.toFixed(4)})`);
		}

		if (hits.length === 0) {
			throw new Error("Expected at least one lexical search hit for 'beta'");
		}
		if (hits[0]?.id !== "m-beta") {
			throw new Error(`Expected top hit to be m-beta, got ${hits[0]?.id}`);
		}
		if (hits[0]?.metadata.scoring !== "bm25") {
			throw new Error("Expected lexical hit scoring metadata to be 'bm25'");
		}
		if (hits[0]?.similarity <= 0) {
			throw new Error("Expected lexical hit similarity to be positive");
		}

		// Empty keywords should return an empty array without throwing.
		const emptyHits = await manager.lexicalSearchMessages({ userId: "u1", keywords: [] });
		console.log(`empty keyword search returned ${emptyHits.length} hit(s)`);
		if (emptyHits.length !== 0) {
			throw new Error("Expected empty keyword search to return no hits");
		}
	} finally {
		await manager.close();
		rmSync(scratchDir, { recursive: true, force: true });
		console.log("\ntemporary database cleaned up");
	}

	console.log("\n[OK] SQLite tutorial completed");
}

export default main;

runIfMain("SQLite tutorial", main);
