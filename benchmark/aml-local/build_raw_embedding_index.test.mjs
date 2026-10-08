import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SQLiteRawMessageManager } from "../../packages/sqlite/dist/raw-message-manager.js";
import { initializeRawMessageSchema } from "../../packages/sqlite/dist/schema.js";
import {
	assertCompatibleEmbeddingCache,
	assertCompleteIndex,
	assertCompleteRechunkIndex,
	assertConsumableIndex,
	assertConsumableRechunkIndex,
	assertEmbeddingProfile,
	embeddingProfile,
	ensureIndexVectorTable,
	hashFile,
	initializeRechunkIndex,
	parentFingerprint,
	persistBatch,
	rechunkProfile,
	sha256,
	validateEmbedding,
} from "./build_raw_embedding_index.mjs";

const require = createRequire(new URL("../../packages/sqlite/dist/raw-message-manager.js", import.meta.url));
const Database = require("better-sqlite3");
const vector = Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0));
const identity = JSON.stringify(embeddingProfile);

test("M3 experiment distinguishes native input context, runtime cap and vector dimensions; hashes files as streams", async () => {
	assert.equal(embeddingProfile.dimensions, 1024);
	assert.equal(embeddingProfile.model_max_tokens, 8192);
	assert.equal(rechunkProfile.chunk_max_tokens, 1024);
	assert.equal(rechunkProfile.chunk_overlap_tokens, 128);
	assert(embeddingProfile.max_tokens >= rechunkProfile.chunk_max_tokens + 2);
	assert(embeddingProfile.max_tokens <= embeddingProfile.model_max_tokens);
	assert.equal(embeddingProfile.query_prefix, "");
	const scratch = mkdtempSync(join(tmpdir(), "embedding-hash-"));
	try {
		const content = Buffer.alloc(2 * 1024 * 1024, 17);
		const file = join(scratch, "fixture.bin");
		writeFileSync(file, content);
		assert.equal(await hashFile(file), sha256(content));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

function fixture() {
	const db = new Database(":memory:");
	require("sqlite-vec").load(db);
	db.exec(
		"CREATE TABLE raw_message_chunks(id INTEGER PRIMARY KEY,chunk_id TEXT UNIQUE,content TEXT,content_hash TEXT,embedding BLOB,embedding_model TEXT,embedding_dimensions INTEGER,embedding_updated_at INTEGER); CREATE TABLE embedding_index_state(singleton INTEGER PRIMARY KEY,identity TEXT,last_id INTEGER,completed INTEGER,status TEXT)",
	);
	ensureIndexVectorTable(db, 1024);
	db.prepare("INSERT INTO embedding_index_state VALUES(1,?,0,0,'running')").run(identity);
	const rows = [1, 2].map((id) => ({
		id,
		chunk_id: `c${id}`,
		content: `evidence ${id}`,
		content_hash: sha256(`evidence ${id}`),
	}));
	for (const row of rows)
		db.prepare("INSERT INTO raw_message_chunks(id,chunk_id,content,content_hash) VALUES(?,?,?,?)").run(
			row.id,
			row.chunk_id,
			row.content,
			row.content_hash,
		);
	return { db, rows };
}

test("embeddings require finite, normalized vectors with exact dimensions", () => {
	validateEmbedding(vector, 1024);
	assert.throws(() => validateEmbedding([1], 1024));
	assert.throws(() =>
		validateEmbedding(
			vector.map(() => 0),
			1024,
		),
	);
	assert.throws(() => validateEmbedding([Number.NaN, ...vector.slice(1)], 1024));
});

test("real sqlite-vec batches resume atomically without changing source text", () => {
	const { db, rows } = fixture();
	try {
		assert.throws(() => assertCompleteIndex(db, identity));
		persistBatch(db, rows.slice(0, 1), [vector], identity);
		assert.throws(() => assertCompleteIndex(db, identity));
		assert.throws(() => persistBatch(db, rows.slice(0, 1), [vector], identity));
		const otherVector = vector.map((_, index) => (index === 1 ? 1 : 0));
		persistBatch(db, rows.slice(1), [otherVector], identity);
		assert.equal(assertCompleteIndex(db, identity), 2);
		assert.throws(() => assertConsumableIndex(db, identity), /not finalized/);
		db.prepare("UPDATE embedding_index_state SET status='complete'").run();
		assert.equal(assertConsumableIndex(db, identity), 2);
		assert.deepEqual(
			db.prepare("SELECT id,chunk_id,content,content_hash FROM raw_message_chunks ORDER BY id").all(),
			rows,
		);
		assert.equal(
			db
				.prepare(
					"SELECT chunk_id FROM raw_message_chunks_vec_d1024 WHERE embedding MATCH ? ORDER BY distance LIMIT 1",
				)
				.get(Buffer.from(new Float32Array(vector).buffer)).chunk_id,
			"c1",
		);
		assert.throws(() => assertCompleteIndex(db, "different"));
	} finally {
		db.close();
	}
});

test("missing rows roll back vectors and checkpoint together", () => {
	const { db, rows } = fixture();
	try {
		db.prepare("DELETE FROM raw_message_chunks WHERE id=2").run();
		assert.throws(() => persistBatch(db, rows, [vector, vector], identity));
		assert.equal(db.prepare("SELECT COUNT(*) total FROM raw_message_chunks_vec_d1024").get().total, 0);
		assert.equal(db.prepare("SELECT completed FROM embedding_index_state").get().completed, 0);
		assert.equal(db.prepare("SELECT embedding FROM raw_message_chunks WHERE id=1").get().embedding, null);
	} finally {
		db.close();
	}
});

test("changed content, identity and incomplete vectors fail before committing", () => {
	const { db, rows } = fixture();
	try {
		assert.throws(() => persistBatch(db, [{ ...rows[0], content: "changed" }], [vector], identity));
		assert.throws(() => persistBatch(db, rows, [vector], identity));
		assert.throws(() => persistBatch(db, rows, [vector, vector], "different"));
		assert.equal(db.prepare("SELECT completed FROM embedding_index_state").get().completed, 0);
	} finally {
		db.close();
	}
});

test("1024-dimensional completion rejects wrong model metadata and deletes native entries with source rows", () => {
	const { db, rows } = fixture();
	try {
		persistBatch(db, rows, [vector, vector], identity);
		assert.equal(assertCompleteIndex(db, identity), 2);
		db.prepare("UPDATE raw_message_chunks SET embedding_model='old-model' WHERE id=1").run();
		assert.throws(() => assertCompleteIndex(db, identity), /Mixed embedding/);
		db.prepare("DELETE FROM raw_message_chunks WHERE id=1").run();
		assert.equal(db.prepare("SELECT COUNT(*) total FROM raw_message_chunks_vec_d1024").get().total, 1);
		assert.throws(() => ensureIndexVectorTable(db, Number.NaN));
	} finally {
		db.close();
	}
});

test("rechunk initialization and idempotent replay preserve parents while rebuilding native FTS5 and ANN", async () => {
	const db = new Database(":memory:");
	const manager = new SQLiteRawMessageManager({ db });
	try {
		await manager.storeMessages([
			{
				messageId: "p1",
				userId: "u",
				botId: "b",
				platform: "fixture",
				content: "first needle 😀 last",
				createdAt: 1,
				metadata: { unchanged: true },
			},
			{
				messageId: "p2",
				userId: "u",
				botId: "b",
				platform: "fixture",
				content: "other evidence",
				timestamp: 17,
				createdAt: 2,
			},
		]);
		const original = db.prepare("SELECT * FROM raw_messages ORDER BY id").all();
		const manifest = {
			...rechunkProfile,
			source_parents: { total: 2, maximum: original.at(-1).id },
			parent_fingerprint: parentFingerprint(db),
		};
		const rechunkIdentity = JSON.stringify(manifest);
		initializeRechunkIndex(db, rechunkIdentity, initializeRawMessageSchema);
		assert.equal(db.prepare("SELECT COUNT(*) n FROM raw_message_chunks").get().n, 0);
		assert.deepEqual(db.prepare("SELECT * FROM raw_messages ORDER BY id").all(), original);
		assert.throws(() => assertConsumableRechunkIndex(db, rechunkIdentity), /not finalized/);
		assertEmbeddingProfile({ ...manifest, batch_size: 16 });
		assert.throws(() => assertEmbeddingProfile({ ...manifest, batch_size: 0 }), /batch size/);
		assert.throws(() => assertEmbeddingProfile({ ...manifest, chunk_max_tokens: 512 }), /profile changed/);
		assertCompatibleEmbeddingCache(db, { ...manifest, batch_size: 16 });
		assert.throws(
			() => assertCompatibleEmbeddingCache(db, { ...manifest, source_sha256: "another corpus" }),
			/cache differs/,
		);
		assert.throws(
			() => assertCompatibleEmbeddingCache(db, { ...manifest, model_files: { changed: true } }),
			/cache differs/,
		);
		for (const row of original) {
			const chunk = {
				chunkId: `${row.message_id}:new`,
				messageId: row.message_id,
				userId: row.user_id,
				content: row.content,
				contentHash: sha256(row.content),
				chunkIndex: 0,
				chunkCount: 1,
				startPosition: 0,
				endPosition: row.content.length,
				embedding: vector,
				embeddingModel: rechunkProfile.model,
				embeddingDimensions: 1024,
			};
			const plan = {
				messageId: row.message_id,
				userId: row.user_id,
				contentHash: sha256(row.content),
				chunks: [chunk],
			};
			await manager.replaceMessageSearchChunks([plan]);
			await manager.replaceMessageSearchChunks([plan]); // Cursor-lag replay after an interruption.
			db.prepare("UPDATE rechunk_index_state SET completed=completed+1,last_id=?").run(row.id);
		}
		assert.equal(assertCompleteRechunkIndex(db, rechunkIdentity), 2);
		initializeRechunkIndex(db, rechunkIdentity, initializeRawMessageSchema); // Resume never clears committed children.
		assert.equal(db.prepare("SELECT COUNT(*) n FROM raw_message_chunks").get().n, 2);
		assert.deepEqual(db.prepare("SELECT * FROM raw_messages ORDER BY id").all(), original);
		assert.equal((await manager.lexicalSearchMessages({ userId: "u", keywords: ["needle"] }))[0]?.id, "p1");
		assert.equal(
			(
				await manager.searchMessagesSemantically({
					userId: "u",
					queryEmbedding: vector,
					embeddingModel: rechunkProfile.model,
					limit: 1,
				})
			)[0]?.id,
			"p1",
		);
		db.prepare("UPDATE rechunk_index_state SET status='complete'").run();
		assert.equal(assertConsumableRechunkIndex(db, rechunkIdentity), 2);
		assert.throws(
			() =>
				initializeRechunkIndex(
					db,
					JSON.stringify({ ...manifest, chunk_overlap_tokens: 63 }),
					initializeRawMessageSchema,
				),
			/configuration changed/,
		);
		db.prepare("UPDATE raw_messages SET timestamp=18 WHERE message_id='p2'").run();
		assert.throws(() => assertConsumableRechunkIndex(db, rechunkIdentity), /parent fields changed/);
	} finally {
		db.close();
	}
});
