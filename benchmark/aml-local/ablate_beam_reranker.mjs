/** Fixed-candidate ablation of two real core implementations, not a new ranker.
 * Historical texts are restored read-only and verified against trace hashes.
 * Only the core-produced contexts are changed; official questions/rubrics stay intact.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const rows = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

export function assertCompleteRerankerScores(scores, candidates) {
	assert(Array.isArray(scores), "Missing model reranker scores");
	const expected = new Set(candidates.map((candidate) => candidate.id));
	assert.equal(expected.size, candidates.length, "Duplicate reranker candidates");
	assert.equal(scores.length, expected.size, "Model did not score every candidate");
	const seen = new Set();
	for (const score of scores) {
		assert(expected.has(score.id), "Model scored an unknown candidate");
		assert(!seen.has(score.id), "Model scored a candidate twice");
		assert(Number.isFinite(score.score), "Invalid model reranker score");
		seen.add(score.id);
	}
	return scores.map((score) => ({ id: score.id, score: score.score }));
}

export function selectRecords(records, perCategory) {
	const groups = new Map();
	for (const record of records) {
		const group = groups.get(record.category) ?? [];
		group.push(record);
		groups.set(record.category, group);
	}
	const ids = new Set(
		[...groups.values()].flatMap((group) =>
			[...group]
				.sort((a, b) => sha256(a.id).localeCompare(sha256(b.id)))
				.slice(0, perCategory)
				.map((record) => record.id),
		),
	);
	return records.filter((record) => ids.has(record.id));
}

export function hydrateHit(hit, userId, getMessage, getChunk) {
	const parent = getMessage(hit.id);
	assert(parent, `Missing parent ${hit.id}`);
	assert.equal(parent.user_id, userId, `Scope mismatch for ${hit.id}`);
	assert.equal(parent.archived_at, null, `Archived parent ${hit.id}`);
	const spans = (hit.matched_spans ?? []).map((span) => {
		const start = span.start_position;
		const end = span.end_position;
		assert(
			Number.isSafeInteger(start) &&
				Number.isSafeInteger(end) &&
				start >= 0 &&
				end >= start &&
				end <= parent.content.length,
			`Invalid UTF-16 span in ${hit.id}`,
		);
		const content = parent.content.slice(start, end);
		assert.equal(sha256(content), span.content_sha256, `Span content changed for ${hit.id}`);
		let primary;
		if (span.matched_content_sha256 !== undefined) {
			const primaryStart = span.matched_start_position;
			const primaryEnd = span.matched_end_position;
			assert(
				Number.isSafeInteger(primaryStart) &&
					Number.isSafeInteger(primaryEnd) &&
					primaryStart >= start &&
					primaryEnd > primaryStart &&
					primaryEnd <= end,
				`Invalid primary UTF-16 span in ${hit.id}`,
			);
			const matchedContent = parent.content.slice(primaryStart, primaryEnd);
			assert.equal(
				sha256(matchedContent),
				span.matched_content_sha256,
				`Primary content changed for ${hit.id}`,
			);
			for (const id of span.source_chunk_ids ?? []) {
				const child = getChunk(id);
				assert(child, `Missing primary child ${id}`);
				assert.equal(child.message_id, hit.id, `Child belongs to another parent: ${id}`);
			}
			primary = { matchedContent, matchedStartPosition: primaryStart, matchedEndPosition: primaryEnd };
		}
		return {
			content,
			...primary,
			sourceChunkId: span.source_chunk_ids?.[0],
			sourceChunkIds: [...(span.source_chunk_ids ?? [])],
			startPosition: start,
			endPosition: end,
			channels: structuredClone(span.channels ?? []),
		};
	});
	const content = spans[0]?.content ?? parent.content;
	assert.equal(sha256(content), hit.content_sha256, `Candidate content changed for ${hit.id}`);
	const chunk = spans[0]?.sourceChunkId ? getChunk(spans[0].sourceChunkId) : undefined;
	if (chunk) assert.equal(chunk.message_id, hit.id, `Child belongs to another parent: ${hit.id}`);
	return {
		id: hit.id,
		content,
		similarity: hit.score,
		metadata: {
			...JSON.parse(parent.metadata ?? "{}"),
			userId,
			messageSequence: parent.message_sequence,
			...(parent.timestamp === null ? {} : { timestamp: parent.timestamp }),
			...(chunk
				? {
						sourceChunkId: chunk.chunk_id,
						sourceChunkIndex: chunk.chunk_index,
						sourceChunkCount: chunk.chunk_count,
					}
				: {}),
			matchedSpans: spans,
			matchedSpansTruncated: hit.matched_spans_truncated ?? 0,
		},
	};
}

/** Restore actually matched child IDs from older traces, without expanding scoring text. */
export function hydratePrimaryHit(hit, userId, getMessage, getChunk) {
	const restored = hydrateHit(hit, userId, getMessage, getChunk);
	const parent = getMessage(hit.id);
	const primarySpans = [];
	const seen = new Set();
	for (const span of restored.metadata.matchedSpans) {
		assert(span.sourceChunkIds.length > 0, `Missing matched child IDs: ${hit.id}`);
		for (const id of span.sourceChunkIds) {
			if (seen.has(id)) continue;
			const child = getChunk(id);
			assert(child, `Missing matched child: ${id}`);
			assert.equal(child.message_id, hit.id, `Matched child belongs to another parent: ${id}`);
			assert.equal(child.user_id, userId, `Matched child scope mismatch: ${id}`);
			assert(
				Number.isSafeInteger(child.start_position) &&
					Number.isSafeInteger(child.end_position) &&
					child.start_position >= span.startPosition &&
					child.end_position > child.start_position &&
					child.end_position <= span.endPosition,
				`Matched child outside its recorded window: ${id}`,
			);
			assert.equal(child.content, parent.content.slice(child.start_position, child.end_position));
			assert.equal(child.content_hash, sha256(child.content), `Matched child hash mismatch: ${id}`);
			seen.add(id);
			primarySpans.push({
				...span,
				sourceChunkId: id,
				sourceChunkIds: [id],
				matchedContent: child.content,
				matchedStartPosition: child.start_position,
				matchedEndPosition: child.end_position,
			});
		}
	}
	assert(primarySpans.length > 0, `No exact primary evidence: ${hit.id}`);
	return { ...restored, metadata: { ...restored.metadata, matchedSpans: primarySpans } };
}

export function assertReplay(output, trace, record) {
	const fused = output.retrievalDiagnostics?.fusedBeforeRerank ?? [];
	assert.deepEqual(
		fused.map((hit) => hit.id),
		trace.before_rerank.map((hit) => hit.id),
		`Fusion replay differs: ${record.id}`,
	);
	fused.forEach((hit, index) =>
		assert.equal(
			sha256(hit.content),
			trace.before_rerank[index].content_sha256,
			`Fused content differs: ${record.id}/${hit.id}`,
		),
	);
	assert.deepEqual(
		output.results.map((hit) => hit.id),
		trace.after_rerank.map((hit) => hit.id),
		`Rerank replay differs: ${record.id}`,
	);
	assert.deepEqual(
		output.results.map((hit) => hit.content),
		record.retrieved_context,
		`Answer context replay differs: ${record.id}`,
	);
}

async function main() {
	const options = {};
	for (let index = 2; index < process.argv.length; index += 2)
		options[process.argv[index].replace(/^--/, "")] = process.argv[index + 1];
	for (const key of ["run", "db", "baseline-root", "current-root", "output"])
		assert(options[key], `Missing --${key}`);
	const perCategory = Number(options["per-category"] ?? 2);
	assert(Number.isSafeInteger(perCategory) && perCategory > 0);
	const intervention = options.intervention ?? "fusion-window";
	assert(["fusion-window", "lexical-dedup", "reranker-model"].includes(intervention), "Unknown intervention");
	const run = path.resolve(options.run);
	const output = path.resolve(options.output);
	assert.notEqual(output, run, "Cannot overwrite the reference run");
	const modulePath = (root) => path.resolve(root, "packages/memory-store/dist/search/unified-search.js");
	const baselinePath = modulePath(options["baseline-root"]);
	const currentPath = modulePath(options["current-root"]);
	const baseline = await import(pathToFileURL(baselinePath).href);
	const current = await import(pathToFileURL(currentPath).href);
	// Use the exact production driver for FTS queries. Node's bundled SQLite
	// can choose a different join order despite identical SQL and corpus.
	const require = createRequire(
		pathToFileURL(path.resolve(options["current-root"], "packages/sqlite/dist/raw-message-manager.js")),
	);
	const BetterSqlite = require("better-sqlite3");
	const db = new BetterSqlite(path.resolve(options.db), { readonly: true, fileMustExist: true });
	const { LocalTransformersReranker } = await import(
		pathToFileURL(
			path.resolve(options["baseline-root"], "packages/ai/rag/dist/local-transformers-reranker.js"),
		).href
	);
	const rerankerModel = options["reranker-model"] ?? "Xenova/ms-marco-MiniLM-L-6-v2";
	const rerankerCandidateMode = options["reranker-candidate-mode"] ?? "window";
	assert(["window", "matched-chunks"].includes(rerankerCandidateMode), "Unknown reranker candidate mode");
	const rerankerBatchSize = Number(options["reranker-batch-size"] ?? 8);
	assert(Number.isSafeInteger(rerankerBatchSize) && rerankerBatchSize > 0 && rerankerBatchSize <= 32, "Invalid reranker batch size");
	const reranker = new LocalTransformersReranker({
		modelName: rerankerModel,
		dtype: "q8",
		maxTokens: 512,
		batchSize: rerankerBatchSize,
		localFilesOnly: true,
		candidateMode: rerankerCandidateMode,
	});
	const selected = selectRecords(rows(path.join(run, "input.jsonl")), perCategory);
	const selectedIds = new Set(selected.map((record) => record.id));
	const checkpoints = new Map();
	for (const file of fs.readdirSync(path.join(run, "retrieval-checkpoints"))) {
		if (!file.endsWith(".json")) continue;
		const checkpoint = JSON.parse(fs.readFileSync(path.join(run, "retrieval-checkpoints", file), "utf8"));
		if (selectedIds.has(checkpoint.record.id)) checkpoints.set(checkpoint.record.id, checkpoint);
	}
	assert.equal(checkpoints.size, selected.length, "Incomplete frozen retrieval coverage");
	const identity = {
		reference_input_sha256: sha256(fs.readFileSync(path.join(run, "input.jsonl"))),
		baseline_module_sha256: sha256(fs.readFileSync(baselinePath)),
		current_module_sha256: sha256(fs.readFileSync(currentPath)),
		selected_ids: selected.map((record) => record.id),
			reranker_model: reranker.getModelName(),
			reranker_candidate_mode: rerankerCandidateMode,
		dtype: "q8",
		max_tokens: 512,
		batch_size: rerankerBatchSize,
		...(intervention === "lexical-dedup"
			? {
					sqlite_version: db.prepare("SELECT sqlite_version() AS version").get().version,
					sqlite_driver: "production better-sqlite3",
				}
			: {}),
		selection: "lowest SHA256(question ID), independently per category",
		official_prompts_changed: false,
			intervention:
				intervention === "fusion-window"
					? "core fusion window only; fixed semantic, lexical, and planner candidates"
					: intervention === "lexical-dedup"
						? "core lexical keyword deduplication only; fixed semantic and planner candidates; unchanged fusion window"
						: "local reranker model and candidate mode only; fixed semantic, lexical, planner candidates and Top-K",
	};
	fs.mkdirSync(path.join(output, "replay-checkpoints"), { recursive: true });
	const manifestPath = path.join(output, "ablation-manifest.json");
	if (fs.existsSync(manifestPath))
		assert.deepEqual(
			JSON.parse(fs.readFileSync(manifestPath, "utf8")),
			identity,
			"Ablation identity changed",
		);
	else fs.writeFileSync(manifestPath, `${JSON.stringify(identity, null, 2)}\n`);
	let lexicalManager;
	if (intervention === "lexical-dedup") {
		const { SQLiteRawMessageManager } = await import(
			pathToFileURL(path.resolve(options["current-root"], "packages/sqlite/dist/raw-message-manager.js")).href
		);
		lexicalManager = new SQLiteRawMessageManager({ db, enableVectorSearch: false });
		// The frozen corpus already has its schema. This read-only fixture skips
		// schema initialization, not retrieval: lexicalSearchMessages and its
		// hydrator, filters, overfetch and score conversion are the real core.
		lexicalManager.init = async () => {};
	}
	const knownSources = new Map(
		rows(path.join(run, "retrieval-traces.jsonl"))
			.flatMap((trace) => Object.values(trace.channels).flat())
			.map((hit) => [hit.id, hit.source_turn_ids ?? []]),
	);
	const parentQuery = db.prepare("SELECT * FROM raw_messages WHERE message_id = ?");
	const chunkQuery = db.prepare(
		"SELECT chunk_id, message_id, chunk_index, chunk_count FROM raw_message_chunks WHERE chunk_id = ?",
	);
	const completed = [];
	try {
		for (const record of selected) {
			const checkpointFile = path.join(output, "replay-checkpoints", `${sha256(record.id)}.json`);
			if (fs.existsSync(checkpointFile)) {
				const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
				assert.equal(checkpoint.record.id, record.id);
				completed.push(checkpoint);
				continue;
			}
			const { trace } = checkpoints.get(record.id);
			const hydrate = (hit) =>
				hydrateHit(
					hit,
					trace.user_id,
					(id) => parentQuery.get(id),
					(id) => chunkQuery.get(id),
				);
			const channels = Object.fromEntries(
				["semantic", "keyword", "planner"].map((name) => [name, (trace.channels[name] ?? []).map(hydrate)]),
			);
			if (lexicalManager) {
				const replay = await lexicalManager.lexicalSearchMessages({
					userId: trace.user_id,
					keywords: baseline.deriveLexicalKeywords(trace.query),
					limit: trace.candidate_k,
				});
				assert.deepEqual(
					replay.map((hit) => hit.id),
					channels.keyword.map((hit) => hit.id),
					`Original FTS5 candidate order differs: ${record.id}`,
				);
				replay.forEach((hit, index) =>
					assert.equal(
						sha256(hit.content),
						sha256(channels.keyword[index].content),
						`Original FTS5 evidence differs: ${record.id}/${hit.id}`,
					),
				);
			}
			assert.equal(
				(trace.channels.entity ?? []).length + (trace.channels.hybrid ?? []).length,
				0,
				"This replay requires the recorded three-channel memory flow",
			);
			let cachedScores;
			let cachedContent;
			const deps = {
				embedQuery: async () => [1],
				searchRawMessagesAnn: async () => structuredClone(channels.semantic),
				searchRawMessagesLexical: async () => structuredClone(channels.keyword),
				reasoning: {
					iterativePlanner: {
						plan: async () => ({
							evidence: structuredClone(channels.planner),
							stats: { iterations: trace.reasoning?.iterations ?? 0, searches: 0, notes: 0 },
						}),
						lastDegraded: () => trace.reasoning?.degraded === true,
					},
				},
				reranker: {
					rerank: async (input) => {
						if (intervention === "lexical-dedup") return reranker.rerank(input);
						if (!cachedScores) {
							cachedScores = await reranker.rerank(input);
							cachedContent = new Map(input.candidates.map((hit) => [hit.id, sha256(hit.content)]));
						}
						const ids = new Set(input.candidates.map((hit) => hit.id));
						for (const hit of input.candidates)
							assert.equal(
								cachedContent.get(hit.id),
								sha256(hit.content),
								"Reranker input changed between arms",
							);
						return cachedScores.filter((hit) => ids.has(hit.id));
					},
				},
			};
			const input = {
				userId: trace.user_id,
				query: trace.query,
				limit: trace.top_k,
				sources: ["memory"],
				mergeStrategy: "rrf",
				reasoningStrategy: "union",
				includeRetrievalDiagnostics: true,
			};
			const changed = await current
				.createUnifiedSearch(
					lexicalManager
						? {
								...deps,
								searchRawMessagesLexical: (request) => lexicalManager.lexicalSearchMessages(request),
							}
						: deps,
				)
				.search(input);
			const replayed = await baseline.createUnifiedSearch(deps).search(input);
			if (intervention !== "reranker-model") assertReplay(replayed, trace, record);
			const sources = knownSources;
			const required = new Set(trace.required_source_turn_ids ?? []);
			const recall = (hits) => {
				if (hits.some((hit) => !sources.has(hit.id))) return null;
				const found = new Set(hits.flatMap((hit) => sources.get(hit.id) ?? []));
				return required.size ? [...required].filter((id) => found.has(id)).length / required.size : null;
			};
			const checkpoint = {
				record: { ...record, retrieved_context: changed.results.map((hit) => hit.content) },
				original_ids: replayed.results.map((hit) => hit.id),
				changed_ids: changed.results.map((hit) => hit.id),
				original_candidate_count: replayed.retrievalDiagnostics.reranker.inputCount,
				changed_candidate_count: changed.retrievalDiagnostics.reranker.inputCount,
				original_source_recall: recall(replayed.results),
				changed_source_recall: recall(changed.results),
				...(lexicalManager
					? {
							original_keywords: baseline.deriveLexicalKeywords(trace.query),
							changed_keywords: current.deriveLexicalKeywords(trace.query),
							unmapped_changed_ids: changed.results
								.filter((hit) => !sources.has(hit.id))
								.map((hit) => hit.id),
						}
					: {}),
				baseline_replay_verified: true,
			};
			const temporary = `${checkpointFile}.tmp`;
			fs.writeFileSync(temporary, JSON.stringify(checkpoint));
			fs.renameSync(temporary, checkpointFile);
			completed.push(checkpoint);
			process.stdout.write(
				`[core-rerank-ablation] ${completed.length}/${selected.length} ${record.id}; candidates ${checkpoint.original_candidate_count}->${checkpoint.changed_candidate_count}; recall ${checkpoint.original_source_recall}->${checkpoint.changed_source_recall}\n`,
			);
		}
	} finally {
		db.close();
	}
	fs.writeFileSync(
		path.join(output, "input.jsonl"),
		completed.map((item) => `${JSON.stringify(item.record)}\n`).join(""),
	);
	const annotated = completed.filter(
		(item) => item.original_source_recall !== null && item.changed_source_recall !== null,
	);
	const deltas = annotated.map((item) => item.changed_source_recall - item.original_source_recall);
	fs.writeFileSync(
		path.join(output, "analysis.json"),
		`${JSON.stringify(
			{
				questions: completed.length,
				annotated: annotated.length,
				baseline_reconstruction_verified: completed.every((item) => item.baseline_replay_verified),
				mean_original_source_recall: average(annotated.map((item) => item.original_source_recall)),
				mean_changed_source_recall: average(annotated.map((item) => item.changed_source_recall)),
				improved: deltas.filter((value) => value > 0).length,
				worsened: deltas.filter((value) => value < 0).length,
				unchanged: deltas.filter((value) => value === 0).length,
				interpretation:
					"Retrieval-only until the unchanged official answer/judge flow is completed; no score claim from source IDs alone. Recall excludes any question with an unmapped new parent ID.",
			},
			null,
			2,
		)}\n`,
	);
	if (options["source-map"]) {
		const supplementText = fs.readFileSync(options["source-map"], "utf8");
		const sources = new Map(knownSources);
		for (const line of supplementText.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line);
			for (const [id, source] of Object.entries(entry.source_ids ?? {})) {
				if (typeof source === "string" || typeof source === "number") sources.set(id, [String(source)]);
			}
		}
		const recalls = completed
			.map((checkpoint) => {
				const required = new Set(checkpoints.get(checkpoint.record.id).trace.required_source_turn_ids ?? []);
				for (const id of checkpoint.changed_ids) assert(sources.has(id), `Unmapped changed parent ${id}`);
				const found = new Set(checkpoint.changed_ids.flatMap((id) => sources.get(id)));
				return {
					id: checkpoint.record.id,
					before: checkpoint.original_source_recall,
					after: required.size ? [...required].filter((id) => found.has(id)).length / required.size : null,
				};
			})
			.filter((item) => item.before !== null);
		fs.writeFileSync(
			path.join(output, "source-mapping-analysis.json"),
			`${JSON.stringify(
				{
					supplement_sha256: sha256(supplementText),
					annotated: recalls.length,
					mean_original_source_recall: average(recalls.map((item) => item.before)),
					mean_changed_source_recall: average(recalls.map((item) => item.after)),
					improved: recalls.filter((item) => item.after > item.before).length,
					worsened: recalls.filter((item) => item.after < item.before).length,
					cases: recalls,
				},
				null,
				2,
			)}\n`,
		);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error.stack ?? String(error)}\n`);
		process.exitCode = 1;
	});
}
