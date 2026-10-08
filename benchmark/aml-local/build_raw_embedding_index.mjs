/** Build a separate, resumable child-embedding index without changing raw evidence. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const embeddingProfile = Object.freeze({
	model: "Xenova/bge-m3",
	revision: "4de13258303883538bd53b696b452bf8099f0858",
	dimensions: 1024,
	pooling: "cls",
	normalize: true,
	dtype: "fp32",
	model_max_tokens: 8192,
	max_tokens: 1152,
	batch_size: 2,
	query_prefix: "",
});

export const rechunkProfile = Object.freeze({
	...embeddingProfile,
	index_kind: "tokenizer-aware-raw-message",
	chunk_max_tokens: 1024,
	chunk_overlap_tokens: 128,
	chunk_tokenizer: embeddingProfile.model,
});

/** Batch scheduling changes execution cost, not the model or source contract. */
export function assertEmbeddingProfile(manifest, profile = rechunkProfile) {
	for (const [key, expected] of Object.entries(profile)) {
		if (key === "batch_size") {
			assert(
				Number.isSafeInteger(manifest[key]) && manifest[key] > 0 && manifest[key] <= 32,
				"Invalid embedding batch size",
			);
		} else assert.equal(manifest[key], expected, `Embedding profile changed: ${key}`);
	}
}

/** A partial index may supply exact cached vectors, never completed retrieval. */
export function assertCompatibleEmbeddingCache(db, manifest) {
	const state = db.prepare("SELECT * FROM rechunk_index_state WHERE singleton=1").get();
	assert(state && ["running", "pending", "complete"].includes(state.status), "Invalid embedding cache state");
	const cached = JSON.parse(state.identity);
	assertEmbeddingProfile(cached);
	for (const key of [
		...Object.keys(rechunkProfile).filter((key) => key !== "batch_size"),
		"source_sha256",
		"source_parents",
		"parent_fingerprint",
		"model_files",
	])
		assert.deepEqual(cached[key], manifest[key], `Embedding cache differs: ${key}`);
	assert.equal(parentFingerprint(db), manifest.parent_fingerprint, "Embedding cache parent evidence changed");
	return state;
}

export function parentFingerprint(db) {
	const hash = createHash("sha256");
	for (const row of db.prepare("SELECT * FROM raw_messages ORDER BY id").iterate()) {
		hash.update(JSON.stringify(row));
		hash.update("\n");
	}
	return hash.digest("hex");
}

/** Clear only derived child tables in an independently owned index copy. */
export function initializeRechunkIndex(db, identity, initializeSchema) {
	const manifest = JSON.parse(identity);
	assert.equal(manifest.index_kind, rechunkProfile.index_kind);
	const existing = db.prepare("SELECT name FROM sqlite_master WHERE name='rechunk_index_state'").get();
	if (existing) {
		assert.equal(
			db.prepare("SELECT identity FROM rechunk_index_state WHERE singleton=1").get()?.identity,
			identity,
			"Rechunk configuration changed",
		);
		return;
	}
	db.transaction(() => {
		const vectorTables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table'")
			.all()
			.map((row) => row.name)
			.filter((name) => /^raw_message_chunks_vec_d\d+$/.test(name));
		for (const name of vectorTables) {
			db.exec(`DROP TRIGGER IF EXISTS "${name}_delete"; DROP TABLE "${name}"`);
		}
		for (const name of ["raw_message_chunks_ai", "raw_message_chunks_ad", "raw_message_chunks_au"])
			db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
		db.exec("DROP TABLE IF EXISTS raw_message_chunks_fts; DROP TABLE IF EXISTS raw_message_chunks");
		initializeSchema(db);
		db.exec(
			"CREATE TABLE rechunk_index_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),identity TEXT NOT NULL,last_id INTEGER NOT NULL,completed INTEGER NOT NULL,status TEXT NOT NULL)",
		);
		db.prepare("INSERT INTO rechunk_index_state VALUES(1,?,0,0,'running')").run(identity);
	}).immediate();
}

export function assertCompleteRechunkIndex(db, identity) {
	const manifest = JSON.parse(identity);
	assertEmbeddingProfile(manifest);
	const state = db.prepare("SELECT * FROM rechunk_index_state WHERE singleton=1").get();
	assert.equal(state.identity, identity, "Rechunk identity mismatch");
	assert.equal(state.completed, manifest.source_parents.total, "Partial parent reindex");
	assert.equal(state.last_id, manifest.source_parents.maximum, "Incomplete parent cursor");
	assert.equal(parentFingerprint(db), manifest.parent_fingerprint, "Original parent fields changed");
	const counts = db
		.prepare(
			"SELECT COUNT(*) total,SUM(embedding_model=? AND embedding_dimensions=? AND length(embedding)=?) embedded FROM raw_message_chunks",
		)
		.get(manifest.model, manifest.dimensions, manifest.dimensions * 4);
	assert.equal(counts.embedded, counts.total, "Mixed or incomplete child embeddings");
	assert.equal(
		db.prepare(`SELECT COUNT(*) n FROM raw_message_chunks_vec_d${manifest.dimensions}`).get().n,
		counts.total,
		"Incomplete child ANN index",
	);
	assert.equal(
		db
			.prepare(
				"SELECT COUNT(*) n FROM raw_messages p WHERE length(p.content)>0 AND NOT EXISTS(SELECT 1 FROM raw_message_chunks c WHERE c.message_id=p.message_id)",
			)
			.get().n,
		0,
		"Missing parent coverage",
	);
	// FTS5's rank=1 integrity check verifies its external-content index against the child catalog.
	db.prepare(
		"INSERT INTO raw_message_chunks_fts(raw_message_chunks_fts,rank) VALUES('integrity-check',1)",
	).run();
	return counts.total;
}

export function assertConsumableRechunkIndex(db, identity) {
	assert.equal(
		db.prepare("SELECT status FROM rechunk_index_state WHERE singleton=1").get()?.status,
		"complete",
		"Rechunk index is not finalized",
	);
	// A read-only consumer cannot invoke FTS5's write-command integrity check.
	const manifest = JSON.parse(identity);
	assertEmbeddingProfile(manifest);
	const state = db.prepare("SELECT * FROM rechunk_index_state WHERE singleton=1").get();
	assert.equal(state.identity, identity);
	assert.equal(state.completed, manifest.source_parents.total);
	assert.equal(state.last_id, manifest.source_parents.maximum);
	assert.equal(parentFingerprint(db), manifest.parent_fingerprint, "Original parent fields changed");
	const counts = db
		.prepare(
			"SELECT COUNT(*) total,SUM(embedding_model=? AND embedding_dimensions=? AND length(embedding)=?) embedded FROM raw_message_chunks",
		)
		.get(manifest.model, manifest.dimensions, manifest.dimensions * 4);
	assert.equal(counts.embedded, counts.total, "Mixed child embeddings");
	assert.equal(
		db.prepare(`SELECT COUNT(*) n FROM raw_message_chunks_vec_d${manifest.dimensions}`).get().n,
		counts.total,
	);
	return counts.total;
}

export function ensureIndexVectorTable(db, dimensions) {
	assert(Number.isSafeInteger(dimensions) && dimensions > 0, "Invalid dimensions");
	db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS raw_message_chunks_vec_d${dimensions}
		USING vec0(embedding float[${dimensions}],chunk_id TEXT PRIMARY KEY);
		CREATE TRIGGER IF NOT EXISTS raw_message_chunks_vec_d${dimensions}_delete
		AFTER DELETE ON raw_message_chunks BEGIN
		DELETE FROM raw_message_chunks_vec_d${dimensions} WHERE chunk_id=OLD.chunk_id; END;`);
}

export function validateEmbedding(vector, dimensions) {
	assert(Array.isArray(vector) && vector.length === dimensions, "Embedding dimension mismatch");
	assert(vector.every(Number.isFinite), "Non-finite embedding");
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	assert(Math.abs(norm - 1) < 0.0001, "Embedding must be normalized");
}

export function persistBatch(db, rows, vectors, identity) {
	const { dimensions, model } = JSON.parse(identity);
	assert(Number.isSafeInteger(dimensions) && dimensions > 0, "Invalid dimensions");
	assert(rows.length > 0, "Empty embedding batch");
	const previous = db.prepare("SELECT * FROM embedding_index_state WHERE singleton=1").get();
	assert.equal(previous.identity, identity, "Changed index identity");
	assert(
		rows[0].id > previous.last_id &&
			rows.every((row, index) => Number.isSafeInteger(row.id) && (!index || row.id > rows[index - 1].id)),
		"Out-of-order embedding batch",
	);
	assert.equal(vectors.length, rows.length, "Incomplete embedding batch");
	for (const [index, row] of rows.entries()) {
		assert.equal(sha256(row.content), row.content_hash, "Source content hash mismatch");
		validateEmbedding(vectors[index], dimensions);
	}
	const update = db.prepare(
		"UPDATE raw_message_chunks SET embedding=?, embedding_model=?, embedding_dimensions=?, embedding_updated_at=? WHERE id=? AND chunk_id=? AND content_hash=?",
	);
	const remove = db.prepare(`DELETE FROM raw_message_chunks_vec_d${dimensions} WHERE chunk_id=?`);
	const insert = db.prepare(
		`INSERT INTO raw_message_chunks_vec_d${dimensions}(embedding,chunk_id) VALUES (?,?)`,
	);
	const state = db.prepare(
		"UPDATE embedding_index_state SET last_id=?, completed=completed+? WHERE singleton=1 AND identity=?",
	);
	db.transaction(() => {
		const now = Date.now();
		for (const [index, row] of rows.entries()) {
			const vector = Buffer.from(new Float32Array(vectors[index]).buffer);
			assert.equal(
				update.run(vector, model, dimensions, now, row.id, row.chunk_id, row.content_hash).changes,
				1,
				"Changed source row",
			);
			remove.run(row.chunk_id);
			insert.run(vector, row.chunk_id);
		}
		assert.equal(state.run(rows.at(-1).id, rows.length, identity).changes, 1, "Changed index identity");
	}).immediate();
}

export function assertCompleteIndex(db, identity) {
	const { dimensions, model } = JSON.parse(identity);
	assert(Number.isSafeInteger(dimensions) && dimensions > 0, "Invalid dimensions");
	const state = db.prepare("SELECT * FROM embedding_index_state WHERE singleton=1").get();
	assert.equal(state.identity, identity, "Index identity mismatch");
	const counts = db
		.prepare(
			"SELECT COUNT(*) total, SUM(embedding_model=? AND embedding_dimensions=? AND length(embedding)=?) embedded FROM raw_message_chunks",
		)
		.get(model, dimensions, dimensions * 4);
	assert.equal(state.completed, counts.total, "Partial embedding index");
	assert.equal(counts.embedded, counts.total, "Mixed embedding index");
	assert.equal(
		db.prepare(`SELECT COUNT(*) total FROM raw_message_chunks_vec_d${dimensions}`).get().total,
		counts.total,
		"Incomplete native vector table",
	);
	return counts.total;
}

/** Consumers must also wait for the producer's final source-integrity check. */
export function assertConsumableIndex(db, identity) {
	const state = db.prepare("SELECT * FROM embedding_index_state WHERE singleton=1").get();
	assert.equal(state.status, "complete", "Embedding index is not finalized");
	return assertCompleteIndex(db, identity);
}

export async function hashFile(file) {
	const hash = createHash("sha256");
	for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
	return hash.digest("hex");
}

async function main() {
	const options = {};
	for (let index = 2; index < process.argv.length; index += 2)
		options[process.argv[index].replace(/^--/, "")] = process.argv[index + 1];
	for (const key of ["root", "db", "output"]) assert(options[key], `Missing --${key}`);
	const root = path.resolve(options.root);
	const sourcePath = path.resolve(options.db);
	const output = path.resolve(options.output);
	assert.notEqual(sourcePath, output, "Cannot overwrite the source corpus");
	if (fs.existsSync(output))
		assert.notEqual(fs.realpathSync(sourcePath), fs.realpathSync(output), "Source/output alias");
	const providerModule = options["provider-module"]
		? path.resolve(options["provider-module"])
		: path.join(root, "packages/ai/rag/dist/local-transformers-embedding-provider.js");
	const device = options.device ?? "cpu";
	const batchSize = Number(options["batch-size"] ?? embeddingProfile.batch_size);
	const parentBatchSize = Number(options["parent-batch-size"] ?? 16);
	assert(Number.isSafeInteger(batchSize) && batchSize > 0 && batchSize <= 32, "Invalid embedding batch size");
	assert(
		Number.isSafeInteger(parentBatchSize) && parentBatchSize > 0 && parentBatchSize <= 256,
		"Invalid parent batch size",
	);
	const deviceId = options["device-id"] === undefined ? undefined : Number(options["device-id"]);
	assert(
		deviceId === undefined || (device === "dml" && Number.isSafeInteger(deviceId) && deviceId >= 0),
		"Invalid DirectML device ID",
	);
	const sessionOptions =
		deviceId === undefined
			? undefined
			: {
					executionProviders: [{ name: "dml", deviceId }],
					enableMemPattern: false,
					executionMode: "sequential",
				};
	const require = createRequire(path.join(root, "packages/sqlite/dist/raw-message-manager.js"));
	const transformersModule = path.join(
		path.dirname(createRequire(providerModule).resolve("@huggingface/transformers")),
		"transformers.node.mjs",
	);
	const Database = require("better-sqlite3");
	const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
	const sourceStat = fs.statSync(sourcePath);
	const { LocalTransformersEmbeddingProvider } = await import(pathToFileURL(providerModule).href);
	const provider = new LocalTransformersEmbeddingProvider({
		modelName: embeddingProfile.model,
		pooling: embeddingProfile.pooling,
		normalize: embeddingProfile.normalize,
		dtype: embeddingProfile.dtype,
		batchSize,
		lengthAwareBatching: options["length-aware-batching"] === "true",
		maxTokens: embeddingProfile.max_tokens,
		localFilesOnly: true,
		device,
		sessionOptions,
	});
	const cache = path.join(provider.getCacheDir(), provider.getModelName());
	const files = [
		"config.json",
		"tokenizer_config.json",
		"tokenizer.json",
		"special_tokens_map.json",
		"onnx/model.onnx",
		"onnx/model.onnx_data",
	];
	const modelFiles = {};
	for (const file of files) modelFiles[file] = await hashFile(path.join(cache, file));
	const modelConfig = JSON.parse(fs.readFileSync(path.join(cache, "config.json"), "utf8"));
	const tokenizerConfig = JSON.parse(fs.readFileSync(path.join(cache, "tokenizer_config.json"), "utf8"));
	assert.equal(modelConfig.hidden_size, embeddingProfile.dimensions, "Wrong model output width");
	assert(
		modelConfig.max_position_embeddings >= embeddingProfile.model_max_tokens,
		"Model does not support the required input length",
	);
	assert(
		tokenizerConfig.model_max_length >= embeddingProfile.model_max_tokens,
		"Tokenizer cannot represent the model input budget",
	);
	console.log("[embedding-index] hashing immutable corpus; no model/API/default changes");
	const manifest = {
		...(options.rechunk === "true" ? rechunkProfile : embeddingProfile),
		batch_size: batchSize,
		parent_batch_size: parentBatchSize,
		length_aware_batching: options["length-aware-batching"] === "true",
		device,
		session_options: sessionOptions,
		provider_module: providerModule,
		source: sourcePath,
		source_sha256: await hashFile(sourcePath),
		source_rows: source.prepare("SELECT COUNT(*) total, MAX(id) maximum FROM raw_message_chunks").get(),
		model: provider.getModelName(),
		model_files: modelFiles,
		provider_sha256: sha256(fs.readFileSync(providerModule)),
		transformers_module: transformersModule,
		transformers_sha256: await hashFile(transformersModule),
		harness_sha256: sha256(fs.readFileSync(new URL(import.meta.url))),
		intervention: "child embedding only; original text, spans, FTS, source IDs and timestamps unchanged",
	};
	if (options.rechunk === "true") {
		assert(options["ingest-module"], "Rechunking requires the compiled core --ingest-module");
		manifest.ingest_module = path.resolve(options["ingest-module"]);
		manifest.ingest_sha256 = sha256(fs.readFileSync(manifest.ingest_module));
		manifest.sqlite_module = options["sqlite-module"]
			? path.resolve(options["sqlite-module"])
			: path.join(root, "packages/sqlite/dist/raw-message-manager.js");
		manifest.sqlite_sha256 = sha256(fs.readFileSync(manifest.sqlite_module));
		manifest.schema_module = options["schema-module"]
			? path.resolve(options["schema-module"])
			: path.join(root, "packages/sqlite/dist/schema.js");
		manifest.schema_sha256 = sha256(fs.readFileSync(manifest.schema_module));
		manifest.source_parents = source.prepare("SELECT COUNT(*) total,MAX(id) maximum FROM raw_messages").get();
		manifest.parent_fingerprint = parentFingerprint(source);
		manifest.intervention =
			"BGE-M3 1024-dimensional embedding plus real-tokenizer 1024/128 rechunking; fresh child FTS5/ANN; original parents unchanged";
	}
	let cachedDb;
	let cachedManager;
	if (options["embedding-cache-db"]) {
		assert(options.rechunk === "true", "Embedding cache requires tokenizer-aware rechunking");
		const cachedPath = path.resolve(options["embedding-cache-db"]);
		assert.notEqual(cachedPath, output, "Cache cannot alias writable output");
		cachedDb = new Database(cachedPath, { readonly: true, fileMustExist: true });
		require("sqlite-vec").load(cachedDb);
		const state = assertCompatibleEmbeddingCache(cachedDb, manifest);
		const { SQLiteRawMessageManager } = await import(pathToFileURL(manifest.sqlite_module).href);
		cachedManager = new SQLiteRawMessageManager({ db: cachedDb, enableVectorSearch: false });
		// The owned, validated cache already has a complete schema; read-only reuse must not initialize it.
		cachedManager.init = async () => {};
		manifest.embedding_cache = {
			path: cachedPath,
			sha256: await hashFile(cachedPath),
			identity_sha256: sha256(state.identity),
			completed_parents: state.completed,
		};
	}
	const identity = JSON.stringify(manifest);
	fs.mkdirSync(path.dirname(output), { recursive: true });
	const created = !fs.existsSync(output);
	if (created) {
		const copying = `${output}.copy-${randomUUID()}.db`;
		console.log("[embedding-index] creating independent SQLite backup");
		await source.backup(copying);
		assert(!fs.existsSync(output), "Output appeared during backup");
		fs.renameSync(copying, output);
	}
	const db = new Database(output, { fileMustExist: true });
	require("sqlite-vec").load(db);
	if (options.rechunk === "true") {
		try {
			assert(
				created || db.prepare("SELECT name FROM sqlite_master WHERE name='rechunk_index_state'").get(),
				"Refusing to modify an unowned rechunk database",
			);
			db.pragma("journal_mode = WAL");
			const { initializeRawMessageSchema } = await import(pathToFileURL(manifest.schema_module).href);
			initializeRechunkIndex(db, identity, initializeRawMessageSchema);
			const { SQLiteRawMessageManager } = await import(pathToFileURL(manifest.sqlite_module).href);
			const { prepareRawMessageIngest } = await import(pathToFileURL(manifest.ingest_module).href);
			const manager = new SQLiteRawMessageManager({ db });
			await manager.init();
			const countTokens = await provider.getTokenCounter();
			const deps = {
				embeddingInfo: { model: manifest.model, dimensions: manifest.dimensions },
				getDocumentChunking: async () => ({
					maxTokens: manifest.chunk_max_tokens,
					overlapTokens: manifest.chunk_overlap_tokens,
					countTokens,
				}),
				embedDocuments: ({ texts }) => provider.embedDocuments(texts),
			};
			const state = () => db.prepare("SELECT * FROM rechunk_index_state WHERE singleton=1").get();
			const saveStatus = (status) =>
				fs.writeFileSync(
					`${output}.status.json`,
					`${JSON.stringify({ ...manifest, status, completed_parents: state().completed, total_parents: manifest.source_parents.total, completed_children: db.prepare("SELECT COUNT(*) n FROM raw_message_chunks").get().n, last_parent_id: state().last_id, updated_at: new Date().toISOString() }, null, 2)}\n`,
				);
			try {
				let lastLog = 0;
				while (true) {
					for (const name of ["provider", "ingest", "sqlite", "schema", "transformers"])
						assert.equal(
							sha256(fs.readFileSync(manifest[`${name}_module`])),
							manifest[`${name}_sha256`],
							`Frozen ${name} module changed`,
						);
					const rows = source
						.prepare("SELECT id,message_id FROM raw_messages WHERE id>? ORDER BY id LIMIT ?")
						.all(state().last_id, parentBatchSize);
					if (!rows.length) break;
					const parents = await Promise.all(rows.map((row) => manager.getMessageById(row.message_id)));
					assert(parents.every(Boolean), "Missing original parent");
					const existingChunks = await manager.getRawMessageSearchChunks({
						messageIds: rows.map((row) => row.message_id),
					});
					if (cachedManager) {
						const present = new Set(existingChunks.map((chunk) => chunk.chunkId));
						const cached = await cachedManager.getRawMessageSearchChunks({
							messageIds: rows.map((row) => row.message_id),
						});
						existingChunks.push(...cached.filter((chunk) => !present.has(chunk.chunkId)));
					}
					const prepared = await prepareRawMessageIngest(parents, true, deps, existingChunks);
					for (const chunk of prepared.chunks) {
						validateEmbedding(chunk.embedding, manifest.dimensions);
						assert(
							countTokens(chunk.content) <= manifest.chunk_max_tokens,
							"Chunk exceeds actual tokenizer budget",
						);
					}
					await manager.replaceMessageSearchChunks(
						parents.map((parent) => ({
							messageId: parent.messageId,
							userId: parent.userId,
							contentHash: sha256(parent.content),
							chunks: prepared.chunks.filter((chunk) => chunk.messageId === parent.messageId),
						})),
					);
					// Replacement is idempotent. If interrupted before this cursor commit, exact children are reused on resume.
					db.prepare(
						"UPDATE rechunk_index_state SET last_id=?,completed=completed+?,status='running' WHERE singleton=1 AND identity=?",
					).run(rows.at(-1).id, rows.length, identity);
					saveStatus("running");
					if (Date.now() - lastLog > 15000) {
						console.log(
							`[rechunk-index] ${state().completed}/${manifest.source_parents.total} parents; ${db.prepare("SELECT COUNT(*) n FROM raw_message_chunks").get().n} new child embeddings committed`,
						);
						lastLog = Date.now();
					}
				}
				const total = assertCompleteRechunkIndex(db, identity);
				assert.equal(fs.statSync(sourcePath).mtimeMs, sourceStat.mtimeMs, "Original corpus changed");
				assert.equal(await hashFile(sourcePath), manifest.source_sha256, "Original corpus hash changed");
				if (manifest.embedding_cache)
					assert.equal(
						await hashFile(manifest.embedding_cache.path),
						manifest.embedding_cache.sha256,
						"Read-only embedding cache changed",
					);
				db.prepare("UPDATE rechunk_index_state SET status='complete' WHERE singleton=1").run();
				saveStatus("complete");
				console.log(
					`[rechunk-index] complete: ${state().completed} parents, ${total} children; raw evidence unchanged`,
				);
			} catch (error) {
				saveStatus("pending");
				throw error;
			}
		} finally {
			cachedDb?.close();
			db.close();
			source.close();
		}
		return;
	}
	if (!created)
		assert(
			db.prepare("SELECT name FROM sqlite_master WHERE name='embedding_index_state'").get(),
			"Refusing to modify an unowned output database",
		);
	db.pragma("journal_mode = WAL");
	db.exec(
		"CREATE TABLE IF NOT EXISTS embedding_index_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL, last_id INTEGER NOT NULL, completed INTEGER NOT NULL, status TEXT NOT NULL)",
	);
	const existing = db.prepare("SELECT * FROM embedding_index_state WHERE singleton=1").get();
	if (existing) assert.equal(existing.identity, identity, "Resume configuration/corpus changed");
	else {
		assert(created, "Missing owned checkpoint");
		db.prepare("INSERT INTO embedding_index_state VALUES(1,?,0,0,'running')").run(identity);
	}
	ensureIndexVectorTable(db, manifest.dimensions);
	const query = db.prepare(
		"SELECT id,chunk_id,content,content_hash FROM raw_message_chunks WHERE id>? ORDER BY id LIMIT 32",
	);
	const readState = db.prepare("SELECT * FROM embedding_index_state WHERE singleton=1");
	const statusPath = `${output}.status.json`;
	const saveStatus = (status) => {
		const state = readState.get();
		fs.writeFileSync(
			statusPath,
			`${JSON.stringify({ ...manifest, status, completed: state.completed, total: manifest.source_rows.total, last_id: state.last_id, updated_at: new Date().toISOString() }, null, 2)}\n`,
		);
	};
	try {
		let lastLog = 0;
		while (true) {
			assert.equal(
				sha256(fs.readFileSync(providerModule)),
				manifest.provider_sha256,
				"Embedding provider changed while indexing",
			);
			const rows = query.all(readState.get().last_id);
			if (!rows.length) break;
			persistBatch(db, rows, await provider.embedDocuments(rows.map((row) => row.content)), identity);
			saveStatus("running");
			if (Date.now() - lastLog > 15000) {
				console.log(
					`[embedding-index] ${readState.get().completed}/${manifest.source_rows.total} children committed`,
				);
				lastLog = Date.now();
			}
		}
		assertCompleteIndex(db, identity);
		assert.equal(fs.statSync(sourcePath).mtimeMs, sourceStat.mtimeMs, "Source corpus changed");
		assert.equal(await hashFile(sourcePath), manifest.source_sha256, "Source corpus hash changed");
		db.prepare("UPDATE embedding_index_state SET status='complete' WHERE singleton=1").run();
		saveStatus("complete");
		console.log(
			`[embedding-index] complete: ${readState.get().completed} child vectors; original corpus unchanged`,
		);
	} catch (error) {
		saveStatus("pending");
		throw error;
	} finally {
		db.close();
		source.close();
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
