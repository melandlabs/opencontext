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
assert(["lexical", "semantic-rrf", "evidence-query"].includes(intervention), "Unknown intervention");
const semanticRrf = intervention === "semantic-rrf";
const evidenceQuery = intervention === "evidence-query";
const nativeSemantic = semanticRrf || evidenceQuery;
if (evidenceQuery) {
	assert.equal(
		process.env.OPENCONTEXT_LLM_MODEL,
		"deepseek/deepseek-v4-flash-0731",
		"Unexpected rewrite model",
	);
	assert.equal(process.env.OPENCONTEXT_LLM_PROVIDER, "OpenInference", "Unexpected rewrite provider");
	assert.equal(process.env.OPENCONTEXT_LLM_REASONING_EFFORT, "none", "Rewrite reasoning must be disabled");
	assert(process.env.OPENCONTEXT_LLM_API_KEY, "Missing process-local rewrite API key");
}
const controlMode = options["control-mode"] ?? "frozen";
assert(["frozen", "fresh-native"].includes(controlMode), "Unknown control mode");
const freshControl = controlMode === "fresh-native";
assert(!freshControl || !semanticRrf, "Semantic RRF requires exact frozen native replay");
assert(!evidenceQuery || freshControl, "Evidence queries require a fresh native paired control");
if (freshControl) assert(options["control-output"], "Fresh control requires --control-output");
const controlOutput = freshControl ? path.resolve(options["control-output"]) : null;
if (freshControl) {
	assert.notEqual(controlOutput, run, "Cannot overwrite the frozen reference");
	assert.notEqual(controlOutput, output, "Control and intervention need separate outputs");
}
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
if (nativeSemantic) {
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
const referenceRecords = rows(path.join(run, "input.jsonl"));
const maxQuestions = Number(options["max-questions"] ?? referenceRecords.length);
assert(Number.isSafeInteger(maxQuestions) && maxQuestions > 0, "Invalid --max-questions");
const requestedIds = options["question-ids"]?.split(",").map((id) => id.trim());
if (requestedIds) {
	assert(!options["max-questions"], "Use either --question-ids or --max-questions");
	assert(requestedIds.length && requestedIds.every(Boolean), "Question IDs must be non-empty");
	assert.equal(new Set(requestedIds).size, requestedIds.length, "Duplicate requested question IDs");
	assert(
		requestedIds.every((id) => referenceRecords.some((record) => record.id === id)),
		"Unknown question ID",
	);
}
const records = requestedIds
	? referenceRecords.filter((record) => requestedIds.includes(record.id))
	: referenceRecords.slice(0, maxQuestions);
assert.equal(new Set(records.map((r) => r.id)).size, records.length, "Duplicate question IDs");
const traces = new Map(rows(path.join(run, "retrieval-traces.jsonl")).map((r) => [r.question_id, r]));
const sources = new Map(rows(options["source-map"]).map((r) => [r.user_id, r.source_ids]));
const parent = db.prepare("SELECT * FROM raw_messages WHERE message_id = ?");
const chunk = db.prepare(
	"SELECT chunk_id, message_id, chunk_index, chunk_count FROM raw_message_chunks WHERE chunk_id = ?",
);
const identity = {
	control: run,
	control_mode: controlMode,
	...(freshControl ? { fresh_control_output: controlOutput, historical_context_replay_required: false } : {}),
	input_sha256: sha256(fs.readFileSync(path.join(run, "input.jsonl"))),
	traces_sha256: sha256(fs.readFileSync(path.join(run, "retrieval-traces.jsonl"))),
	baseline_module_sha256: sha256(fs.readFileSync(options["baseline-module"])),
	current_module_sha256: sha256(fs.readFileSync(currentModule)),
	sqlite_module_sha256: sha256(fs.readFileSync(sqliteModule)),
	reranker_module_sha256: sha256(fs.readFileSync(rerankerModule)),
	harness_sha256: sha256(fs.readFileSync(new URL(import.meta.url))),
	hydration_helper_sha256: sha256(fs.readFileSync(new URL("./ablate_beam_reranker.mjs", import.meta.url))),
	source_map_sha256: sha256(fs.readFileSync(options["source-map"])),
	selected_ids: records.map((r) => r.id),
	reference_questions: referenceRecords.length,
	complete_reference_coverage: records.length === referenceRecords.length,
	semantic_candidates: nativeSemantic
		? "real native ANN"
		: "frozen verified semantic channel, identical in both arms",
	model: reranker.getModelName(),
	dtype: "q8",
	max_tokens: 512,
	batch_size: 8,
	top_k: 12,
	intervention: evidenceQuery
		? "actual core evidence-expression rewriter (three variants) plus lexical rewrite; paired native ANN/FTS5; unchanged local reranker"
		: semanticRrf
			? "actual core semantic variant RRF; frozen expressions; real native ANN/FTS5; exact old-core replay; original local reranker"
			: "actual core opt-in lexical rewrite; frozen variants and semantic candidates; production FTS5; original local reranker",
	...(nativeSemantic
		? {
				embedding_model: embedding.getModelName(),
				embedding_dtype: "fp32",
				embedding_module_sha256: sha256(fs.readFileSync(embeddingModule)),
			}
		: {}),
	new_planner_calls: evidenceQuery ? "bounded per-question calls recorded in rewrite-requests.jsonl" : 0,
	...(evidenceQuery
		? {
				rewriter_module_sha256: sha256(
					fs.readFileSync(path.join(root, "packages/memory-store/dist/index.js")),
				),
				rewrite_model: process.env.OPENCONTEXT_LLM_MODEL,
				rewrite_provider: process.env.OPENCONTEXT_LLM_PROVIDER,
				rewrite_reasoning_effort: process.env.OPENCONTEXT_LLM_REASONING_EFFORT,
				rewrite_max_variants: 3,
			}
		: {}),
	official_prompts_changed: false,
};
fs.mkdirSync(path.join(output, "retrieval-checkpoints"), { recursive: true });
if (freshControl) fs.mkdirSync(controlOutput, { recursive: true });
const manifest = path.join(output, "ablation-manifest.json");
if (fs.existsSync(manifest))
	assert.deepEqual(JSON.parse(fs.readFileSync(manifest)), identity, "Changed experiment identity");
else fs.writeFileSync(manifest, `${JSON.stringify(identity, null, 2)}\n`);
if (freshControl) {
	const controlManifest = path.join(controlOutput, "ablation-manifest.json");
	if (fs.existsSync(controlManifest))
		assert.deepEqual(JSON.parse(fs.readFileSync(controlManifest)), identity, "Changed control identity");
	else fs.writeFileSync(controlManifest, `${JSON.stringify(identity, null, 2)}\n`);
}
const completed = [];
const pending = [];
let createUserVoiceRewriter;
const rewriteResponses = new Map();
if (evidenceQuery) {
	({ createUserVoiceRewriter } = await import(
		pathToFileURL(path.join(root, "packages/memory-store/dist/index.js")).href
	));
	const file = path.join(output, "rewrite-responses.jsonl");
	if (fs.existsSync(file))
		for (const row of rows(file)) rewriteResponses.set(`${row.id}:${row.prompt_sha256}`, row);
}
const completeRewrite = async (id, prompt) => {
	const promptHash = sha256(prompt);
	const cached = rewriteResponses.get(`${id}:${promptHash}`);
	if (cached) {
		assert.equal(cached.provider, "OpenInference");
		assert.equal(cached.model, "deepseek/deepseek-v4-flash-0731");
		assert.equal(sha256(cached.content), cached.content_sha256);
		return cached.content;
	}
	let lastError;
	for (let attempt = 1; attempt <= 3; attempt++) {
		const started = Date.now();
		let audit = {
			id,
			prompt_sha256: promptHash,
			attempt,
			requested_provider: "OpenInference",
			status: "error",
		};
		try {
			const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST",
				signal: AbortSignal.timeout(120000),
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${process.env.OPENCONTEXT_LLM_API_KEY}`,
				},
				body: JSON.stringify({
					model: process.env.OPENCONTEXT_LLM_MODEL,
					provider: { order: ["OpenInference"], allow_fallbacks: false },
					reasoning: { effort: "none" },
					temperature: 0,
					messages: [{ role: "user", content: prompt }],
				}),
			});
			const payload = await response.json();
			const choice = payload.choices?.[0];
			audit = {
				...audit,
				provider: payload.provider,
				model: payload.model,
				http_status: response.status,
				finish_reason: choice?.finish_reason,
				usage: payload.usage,
			};
			assert(response.ok, `Rewrite HTTP ${response.status}`);
			assert.equal(payload.provider?.toLowerCase(), "openinference", "Rewrite provider mismatch");
			assert.equal(payload.model, process.env.OPENCONTEXT_LLM_MODEL, "Rewrite model mismatch");
			assert.equal(
				payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
				0,
				"Unexpected rewrite reasoning tokens",
			);
			assert.equal(choice?.finish_reason, "stop", "Incomplete rewrite completion");
			assert(
				typeof choice?.message?.content === "string" && choice.message.content.trim(),
				"Empty rewrite completion",
			);
			const row = {
				id,
				prompt_sha256: promptHash,
				provider: payload.provider,
				model: payload.model,
				content: choice.message.content,
				content_sha256: sha256(choice.message.content),
			};
			fs.appendFileSync(path.join(output, "rewrite-responses.jsonl"), `${JSON.stringify(row)}\n`);
			rewriteResponses.set(`${id}:${promptHash}`, row);
			audit.status = "success";
			return row.content;
		} catch (error) {
			lastError = error;
			audit.error = String(error);
		} finally {
			fs.appendFileSync(
				path.join(output, "rewrite-requests.jsonl"),
				`${JSON.stringify({ ...audit, elapsed_ms: Date.now() - started })}\n`,
			);
		}
		if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
	}
	throw lastError;
};
const saveStatus = (status) => {
	const payload = `${JSON.stringify({ status, succeeded: completed.length, total: records.length, pending_ids: pending, updated_at: new Date().toISOString() }, null, 2)}\n`;
	fs.writeFileSync(path.join(output, "retrieval-status.json"), payload);
	if (freshControl) fs.writeFileSync(path.join(controlOutput, "retrieval-status.json"), payload);
};
saveStatus("running");
try {
	for (const record of records) {
		const file = path.join(output, "retrieval-checkpoints", `${sha256(record.id)}.json`);
		if (fs.existsSync(file)) {
			const checkpoint = JSON.parse(fs.readFileSync(file));
			assert.equal(checkpoint.record.id, record.id, "Checkpoint question mismatch");
			assert(checkpoint.control_replay_verified, "Unverified control checkpoint");
			if (freshControl)
				assert(checkpoint.control_record && checkpoint.control_trace, "Missing paired control");
			completed.push(checkpoint);
			saveStatus("running");
			continue;
		}
		try {
			const trace = traces.get(record.id);
			assert(trace?.reasoning?.strategy === "rewrite", "A frozen rewrite control is required");
			assert.equal(trace.top_k, 12);
			const variants = trace.reasoning.rewrittenQueries;
			assert(
				Array.isArray(variants) && variants[0] === trace.query.trim(),
				"Missing original-first query variants",
			);
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
			const nativeLexical = async (request) => {
				const hits = await manager.lexicalSearchMessages(request);
				fs.appendFileSync(
					path.join(output, "lexical-queries.jsonl"),
					`${JSON.stringify({ id: record.id, arm, keywords: request.keywords, limit: request.limit, user_id: request.userId, hits: hits.map((hit) => ({ id: hit.id, bm25_rank: hit.bm25Rank, score: hit.similarity, content_sha256: sha256(hit.content) })) })}\n`,
				);
				return hits;
			};
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
			if (!freshControl) {
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
			} else {
				assert.deepEqual(
					baseline.deriveLexicalKeywords(trace.query),
					current.deriveLexicalKeywords(trace.query),
					"Control keyword policies differ",
				);
			}
			const deps = {
				embedQuery: nativeSemantic
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
				searchRawMessagesAnn: nativeSemantic ? nativeAnn : async () => structuredClone(semantic),
				searchRawMessagesLexical: nativeLexical,
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
			if (!freshControl) assertReplay(control, trace, record);
			else {
				assert.equal(control.retrievalDiagnostics?.reranker.enabled, true, "Control reranker is required");
				assert.deepEqual(
					control.retrievalDiagnostics.channels.lexical.map((hit) => hit.id),
					originalLexical.map((hit) => hit.id),
					"Fresh control did not use the real original-query FTS order",
				);
				const freshRecord = { ...record, retrieved_context: control.results.map((hit) => hit.content) };
				const freshTrace = {
					before_rerank: control.retrievalDiagnostics.fusedBeforeRerank.map((hit) => ({
						id: hit.id,
						content_sha256: sha256(hit.content),
					})),
					after_rerank: control.results.map((hit) => ({ id: hit.id })),
				};
				arm = "current-default";
				assertReplay(await current.createUnifiedSearch(deps).search(input), freshTrace, freshRecord);
			}
			// Current default must also replay identically before the one-switch intervention.
			if (semanticRrf) assertReplay(await current.createUnifiedSearch(deps).search(input), trace, record);
			arm = "changed";
			const evidenceRewriter = evidenceQuery
				? createUserVoiceRewriter({
						style: "evidence",
						maxVariants: 3,
						complete: (prompt) => completeRewrite(record.id, prompt),
					})
				: null;
			const changed = await current
				.createUnifiedSearch({
					...deps,
					reasoning: {
						...deps.reasoning,
						...(semanticRrf ? { rewriteSemanticMerge: "rrf" } : { rewriteLexical: true }),
						...(evidenceRewriter ? { queryRewriter: evidenceRewriter } : {}),
					},
				})
				.search(input);
			if (evidenceQuery)
				assert(!changed.reasoning?.degraded, "Evidence rewrite degraded; preserve this question as pending");
			const sourceMap = sources.get(trace.user_id);
			assert(sourceMap, "Missing canonical user source map");
			const serialize = (hit, index) => {
				assert(sourceMap[hit.id], `Unmapped parent ${hit.id}`);
				const message = parent.get(hit.id);
				assert(message, `Missing native parent ${hit.id}`);
				assert.equal(message.user_id, trace.user_id, `Native parent scope mismatch ${hit.id}`);
				assert.equal(message.archived_at, null, `Archived native parent ${hit.id}`);
				for (const span of hit.metadata.matchedSpans ?? []) {
					assert(
						Number.isSafeInteger(span.startPosition) &&
							Number.isSafeInteger(span.endPosition) &&
							span.startPosition >= 0 &&
							span.endPosition >= span.startPosition &&
							span.endPosition <= message.content.length,
						`Invalid native span ${hit.id}`,
					);
					assert.equal(
						message.content.slice(span.startPosition, span.endPosition),
						span.content,
						`Native span differs from raw evidence ${hit.id}`,
					);
					for (const id of span.sourceChunkIds ?? (span.sourceChunkId ? [span.sourceChunkId] : []))
						assert.equal(chunk.get(id)?.message_id, hit.id, `Native child belongs to another parent ${id}`);
				}
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
			const materialize = (result) => {
				const diagnostics = result.retrievalDiagnostics;
				assert(
					diagnostics?.reranker.enabled && diagnostics.reranker.inputCount <= trace.candidate_k,
					"Reranker/budget contract changed",
				);
				const after = result.results.map(serialize);
				assert(diagnostics.candidateCounts, "Core candidate counts are required for the trace");
				const found = [...new Set(after.flatMap((hit) => hit.source_turn_ids))];
				return {
					record: { ...record, retrieved_context: result.results.map((hit) => hit.content) },
					trace: {
						...trace,
						ablation_control_mode: controlMode,
						semantic_execution: nativeSemantic ? "native-ann" : "frozen-verified-channel",
						reasoning: result.reasoning,
						candidate_counts: diagnostics.candidateCounts,
						warnings: result.warnings ?? [],
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
						search_response: result.results.map((hit) => ({
							id: hit.id,
							content: hit.content,
							score: hit.similarity,
						})),
					},
				};
			};
			const changedRow = materialize(changed);
			const controlRow = freshControl ? materialize(control) : null;
			const row = {
				...changedRow,
				control_replay_verified: true,
				original_ids: control.results.map((hit) => hit.id),
				...(freshControl ? { control_record: controlRow.record, control_trace: controlRow.trace } : {}),
			};
			fs.writeFileSync(`${file}.tmp`, JSON.stringify(row));
			fs.renameSync(`${file}.tmp`, file);
			completed.push(row);
			saveStatus("running");
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
			saveStatus("running");
		}
	}
} finally {
	db.close();
}
saveStatus(pending.length ? "pending" : "complete");
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
	if (freshControl) {
		fs.writeFileSync(
			path.join(controlOutput, "input.jsonl"),
			completed.map((row) => `${JSON.stringify(row.control_record)}\n`).join(""),
		);
		fs.writeFileSync(
			path.join(controlOutput, "retrieval-traces.jsonl"),
			completed.map((row) => `${JSON.stringify(row.control_trace)}\n`).join(""),
		);
	}
}
