/** Real core query-fusion ablation. Frozen expressions, production FTS5,
 * unchanged local cross-encoder; semantic-RRF additionally runs real ANN. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertReplay, hydrateHit, sha256 } from "./ablate_beam_reranker.mjs";

const options = {};
for (let i = 2; i < process.argv.length; i += 2)
	options[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
for (const key of ["run", "root", "baseline-module", "db", "source-map", "output"])
	assert(options[key], `Missing --${key}`);
const run = path.resolve(options.run);
const root = path.resolve(options.root);
const output = path.resolve(options.output);
const intervention = options.intervention ?? "lexical";
assert(["lexical", "semantic-rrf"].includes(intervention), "Unknown intervention");
const semanticRrf = intervention === "semantic-rrf";
assert.notEqual(run, output, "Cannot overwrite the control");
const rows = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const currentModule = path.join(root, "packages/memory-store/dist/search/unified-search.js");
const baseline = await import(pathToFileURL(path.resolve(options["baseline-module"])).href);
const current = await import(pathToFileURL(currentModule).href);
const sqliteModule = path.join(root, "packages/sqlite/dist/raw-message-manager.js");
const require = createRequire(pathToFileURL(sqliteModule));
const db = new (require("better-sqlite3"))(path.resolve(options.db), { readonly: true, fileMustExist: true });
const { SQLiteRawMessageManager } = await import(pathToFileURL(sqliteModule).href);
const manager = new SQLiteRawMessageManager({ db, enableVectorSearch: false });
manager.init = async () => {}; // Existing read-only schema; real queries and hydration remain enabled.
let embedding;
const embeddingModule = path.join(root, "packages/ai/rag/dist/local-transformers-embedding-provider.js");
if (semanticRrf) {
	require("sqlite-vec").load(db);
	assert(
		db.prepare("SELECT name FROM sqlite_master WHERE name = 'raw_message_chunks_vec_d384'").get(),
		"Native ANN index missing",
	);
	manager.vectorSearchAvailable = true;
	const { LocalTransformersEmbeddingProvider } = await import(pathToFileURL(embeddingModule).href);
	embedding = new LocalTransformersEmbeddingProvider({ dtype: "fp32", localFilesOnly: true });
}
const embeddings = new Map();
const rerankerModule = path.join(root, "packages/ai/rag/dist/local-transformers-reranker.js");
const { LocalTransformersReranker } = await import(pathToFileURL(rerankerModule).href);
const reranker = new LocalTransformersReranker({
	dtype: "q8",
	maxTokens: 512,
	batchSize: 8,
	localFilesOnly: true,
});
const records = rows(path.join(run, "input.jsonl"));
assert.equal(new Set(records.map((r) => r.id)).size, records.length, "Duplicate question IDs");
const traces = new Map(rows(path.join(run, "retrieval-traces.jsonl")).map((r) => [r.question_id, r]));
const sources = new Map(rows(options["source-map"]).map((r) => [r.user_id, r.source_ids]));
const parent = db.prepare("SELECT * FROM raw_messages WHERE message_id = ?");
const chunk = db.prepare(
	"SELECT chunk_id, message_id, chunk_index, chunk_count FROM raw_message_chunks WHERE chunk_id = ?",
);
const identity = {
	control: run,
	input_sha256: sha256(fs.readFileSync(path.join(run, "input.jsonl"))),
	traces_sha256: sha256(fs.readFileSync(path.join(run, "retrieval-traces.jsonl"))),
	baseline_module_sha256: sha256(fs.readFileSync(options["baseline-module"])),
	current_module_sha256: sha256(fs.readFileSync(currentModule)),
	sqlite_module_sha256: sha256(fs.readFileSync(sqliteModule)),
	reranker_module_sha256: sha256(fs.readFileSync(rerankerModule)),
	harness_sha256: sha256(fs.readFileSync(new URL(import.meta.url))),
	source_map_sha256: sha256(fs.readFileSync(options["source-map"])),
	selected_ids: records.map((r) => r.id),
	model: reranker.getModelName(),
	dtype: "q8",
	max_tokens: 512,
	batch_size: 8,
	top_k: 12,
	intervention: semanticRrf
		? "actual core semantic variant RRF; frozen expressions; real native ANN/FTS5; exact old-core replay; original local reranker"
		: "actual core opt-in lexical rewrite; frozen variants and semantic candidates; production FTS5; original local reranker",
	...(semanticRrf
		? {
				embedding_model: embedding.getModelName(),
				embedding_dtype: "fp32",
				embedding_module_sha256: sha256(fs.readFileSync(embeddingModule)),
			}
		: {}),
	new_planner_calls: 0,
	official_prompts_changed: false,
};
fs.mkdirSync(path.join(output, "retrieval-checkpoints"), { recursive: true });
const manifest = path.join(output, "ablation-manifest.json");
if (fs.existsSync(manifest))
	assert.deepEqual(JSON.parse(fs.readFileSync(manifest)), identity, "Changed experiment identity");
else fs.writeFileSync(manifest, `${JSON.stringify(identity, null, 2)}\n`);
const completed = [];
const pending = [];
try {
	for (const record of records) {
		const file = path.join(output, "retrieval-checkpoints", `${sha256(record.id)}.json`);
		if (fs.existsSync(file)) {
			completed.push(JSON.parse(fs.readFileSync(file)));
			continue;
		}
		try {
			const trace = traces.get(record.id);
			assert(trace?.reasoning?.strategy === "rewrite", "A frozen rewrite control is required");
			assert.equal(trace.top_k, 12);
			const variants = trace.reasoning.rewrittenQueries;
			assert(Array.isArray(variants) && variants[0] === trace.query, "Missing original-first query variants");
			const semantic = trace.channels.semantic.map((hit) =>
				hydrateHit(
					hit,
					trace.user_id,
					(id) => parent.get(id),
					(id) => chunk.get(id),
				),
			);
			const nativeQueries = new Map();
			let arm = "control";
			const nativeAnn = async (request) => {
				const key = JSON.stringify(request);
				if (!nativeQueries.has(key))
					nativeQueries.set(key, await manager.searchMessagesSemantically(request));
				const hits = nativeQueries.get(key);
				fs.appendFileSync(
					path.join(output, "semantic-queries.jsonl"),
					`${JSON.stringify({ id: record.id, arm, user_id: request.userId, limit: request.limit, embedding_sha256: sha256(JSON.stringify(request.queryEmbedding)), hits: hits.map((hit) => ({ id: hit.id, score: hit.similarity, content_sha256: sha256(hit.content), metadata: hit.metadata })) })}\n`,
				);
				return structuredClone(hits);
			};
			const originalLexical = await manager.lexicalSearchMessages({
				userId: trace.user_id,
				keywords: baseline.deriveLexicalKeywords(trace.query),
				limit: trace.candidate_k,
			});
			assert.deepEqual(
				originalLexical.map((hit) => hit.id),
				trace.channels.keyword.map((hit) => hit.id),
				"Original FTS5 order changed",
			);
			originalLexical.forEach((hit, i) =>
				assert.equal(
					sha256(hit.content),
					trace.channels.keyword[i].content_sha256,
					"Original FTS5 text changed",
				),
			);
			const deps = {
				embedQuery: semanticRrf
					? async ({ query: text }) => {
							assert.equal(typeof text, "string", "Tokenizer requires request.query, not the request object");
							if (!embeddings.has(text)) embeddings.set(text, await embedding.embedQuery(text));
							const vector = embeddings.get(text);
							assert.equal(vector.length, 384, "Embedding dimension drift");
							fs.appendFileSync(
								path.join(output, "embedding-queries.jsonl"),
								`${JSON.stringify({ id: record.id, arm, query: text, embedding_sha256: sha256(JSON.stringify(vector)) })}\n`,
							);
							return [...vector];
						}
					: async () => [1],
				searchRawMessagesAnn: semanticRrf ? nativeAnn : async () => structuredClone(semantic),
				searchRawMessagesLexical: (request) => manager.lexicalSearchMessages(request),
				reranker,
				reasoning: {
					queryRewriter: {
						rewrite: async () => [...variants],
						lastDegraded: () => trace.reasoning.degraded === true,
					},
				},
			};
			const input = {
				userId: trace.user_id,
				query: trace.query,
				sources: ["memory"],
				reasoningStrategy: "rewrite",
				mergeStrategy: "rrf",
				limit: 12,
				includeRetrievalDiagnostics: true,
			};
			const control = await baseline.createUnifiedSearch(deps).search(input);
			assertReplay(control, trace, record);
			// Current default must also replay identically before the one-switch intervention.
			if (semanticRrf) assertReplay(await current.createUnifiedSearch(deps).search(input), trace, record);
			arm = "changed";
			const changed = await current
				.createUnifiedSearch({
					...deps,
					reasoning: {
						...deps.reasoning,
						...(semanticRrf ? { rewriteSemanticMerge: "rrf" } : { rewriteLexical: true }),
					},
					searchRawMessagesLexical: async (request) => {
						const hits = await manager.lexicalSearchMessages(request);
						fs.appendFileSync(
							path.join(output, "lexical-queries.jsonl"),
							`${JSON.stringify({ id: record.id, keywords: request.keywords, limit: request.limit, user_id: request.userId, hits: hits.map((hit) => ({ id: hit.id, bm25_rank: hit.bm25Rank, score: hit.similarity, content_sha256: sha256(hit.content) })) })}\n`,
						);
						return hits;
					},
				})
				.search(input);
			const sourceMap = sources.get(trace.user_id);
			assert(sourceMap, "Missing canonical user source map");
			const serialize = (hit, index) => {
				assert(sourceMap[hit.id], `Unmapped parent ${hit.id}`);
				return {
					id: hit.id,
					type: hit.type,
					rank: index + 1,
					score: hit.similarity,
					source_turn_ids: [sourceMap[hit.id]],
					matched_source_turn_ids: trace.required_source_turn_ids.includes(sourceMap[hit.id])
						? [sourceMap[hit.id]]
						: [],
					message_sequence: hit.metadata.messageSequence,
					role: hit.metadata.role,
					timestamp: hit.metadata.timestamp,
					reranker_score: hit.metadata.rerankerScore,
					content_sha256: sha256(hit.content),
					content_excerpt: hit.content.slice(0, 300),
					matched_spans: (hit.metadata.matchedSpans ?? []).map((span) => ({
						start_position: span.startPosition,
						end_position: span.endPosition,
						source_chunk_ids: span.sourceChunkIds ?? (span.sourceChunkId ? [span.sourceChunkId] : []),
						channels: span.channels,
						content_sha256: sha256(span.content),
					})),
				};
			};
			const diagnostics = changed.retrievalDiagnostics;
			assert(
				diagnostics?.reranker.enabled && diagnostics.reranker.inputCount <= trace.candidate_k,
				"Reranker/budget contract changed",
			);
			const after = changed.results.map(serialize);
			const found = [...new Set(after.flatMap((hit) => hit.source_turn_ids))];
			const row = {
				record: { ...record, retrieved_context: changed.results.map((hit) => hit.content) },
				control_replay_verified: true,
				original_ids: control.results.map((hit) => hit.id),
				trace: {
					...trace,
					reasoning: changed.reasoning,
					channels: {
						...trace.channels,
						keyword: (diagnostics.channels.lexical ?? []).map(serialize),
						semantic: (diagnostics.channels.semantic ?? []).map(serialize),
					},
					before_rerank: diagnostics.fusedBeforeRerank.map(serialize),
					after_rerank: after,
					reranker: { ...diagnostics.reranker, provider: "local", model: reranker.getModelName() },
					retrieved_source_turn_ids: found,
					mapped_final_hits: after.length,
					source_recall_at_k: trace.required_source_turn_ids.length
						? trace.required_source_turn_ids.filter((id) => found.includes(id)).length /
							trace.required_source_turn_ids.length
						: null,
					search_response: changed.results.map((hit) => ({
						id: hit.id,
						content: hit.content,
						score: hit.similarity,
					})),
				},
			};
			fs.writeFileSync(`${file}.tmp`, JSON.stringify(row));
			fs.renameSync(`${file}.tmp`, file);
			completed.push(row);
			process.stdout.write(
				`[lexical-rewrite-ablation] ${completed.length}/${records.length} ${record.id}; recall=${row.trace.source_recall_at_k}\n`,
			);
		} catch (error) {
			pending.push(record.id);
			fs.appendFileSync(
				path.join(output, "retrieval-errors.jsonl"),
				`${JSON.stringify({ id: record.id, error: String(error) })}\n`,
			);
			process.stderr.write(`[lexical-rewrite-ablation] ${record.id} pending: ${String(error)}\n`);
		}
	}
} finally {
	db.close();
}
fs.writeFileSync(
	path.join(output, "retrieval-status.json"),
	`${JSON.stringify({ status: pending.length ? "pending" : "complete", succeeded: completed.length, total: records.length, pending_ids: pending }, null, 2)}\n`,
);
if (pending.length) process.exitCode = 1;
else {
	fs.writeFileSync(
		path.join(output, "input.jsonl"),
		completed.map((row) => `${JSON.stringify(row.record)}\n`).join(""),
	);
	fs.writeFileSync(
		path.join(output, "retrieval-traces.jsonl"),
		completed.map((row) => `${JSON.stringify(row.trace)}\n`).join(""),
	);
}
