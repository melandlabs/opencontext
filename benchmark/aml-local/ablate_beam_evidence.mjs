/** Exercise the real core post-ranking selector on frozen, verified evidence.
 * No benchmark prompt, label, answer or retrieval ranking is used by the selector. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hydrateHit, selectRecords, sha256 } from "./ablate_beam_reranker.mjs";

const options = {};
for (let i = 2; i < process.argv.length; i += 2)
	options[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
for (const key of ["run", "db", "root", "output"]) assert(options[key], `Missing --${key}`);
const run = path.resolve(options.run);
const output = path.resolve(options.output);
assert.notEqual(run, output, "Cannot overwrite the control");
const rows = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const root = path.resolve(options.root);
const intervention = options.intervention ?? "extractive";
assert(["extractive", "dialogue"].includes(intervention), "Unknown context intervention");
const moduleFile = path.join(
	root,
	intervention === "extractive"
		? "packages/memory-store/dist/search/evidence-selector.js"
		: "packages/sqlite/dist/raw-message-manager.js",
);
const coreIntervention = await import(pathToFileURL(moduleFile).href);
const { createUnifiedSearch } = await import(
	pathToFileURL(path.join(root, "packages/memory-store/dist/search/unified-search.js")).href
);
const require = createRequire(pathToFileURL(path.join(root, "packages/sqlite/dist/raw-message-manager.js")));
const db = new (require("better-sqlite3"))(path.resolve(options.db), { readonly: true, fileMustExist: true });
const catalog =
	intervention === "dialogue"
		? new coreIntervention.SQLiteRawMessageManager({ db, enableVectorSearch: false })
		: undefined;
const sourceMaps = options["source-map"]
	? new Map(rows(options["source-map"]).map((row) => [row.user_id, row.source_ids]))
	: new Map();
if (intervention === "dialogue")
	assert(sourceMaps.size > 0, "Dialogue analysis requires canonical source mappings");
const parentQuery = db.prepare("SELECT * FROM raw_messages WHERE message_id = ?");
const chunkQuery = db.prepare(
	"SELECT chunk_id, message_id, chunk_index, chunk_count FROM raw_message_chunks WHERE chunk_id = ?",
);
const perCategory = Number(options["per-category"] ?? 2);
assert(Number.isSafeInteger(perCategory) && perCategory > 0, "Invalid per-category selection");
const records = selectRecords(rows(path.join(run, "input.jsonl")), perCategory);
const traces = new Map(
	rows(path.join(run, "retrieval-traces.jsonl")).map((trace) => [trace.question_id, trace]),
);
const provider = "OpenInference";
const model = "deepseek/deepseek-v4-flash-0731";
if (intervention === "extractive") assert(process.env.OPENROUTER_API_KEY, "Missing OpenRouter credentials");
const identity = {
	control: run,
	control_traces_sha256: sha256(fs.readFileSync(path.join(run, "retrieval-traces.jsonl"))),
	harness_sha256: sha256(fs.readFileSync(new URL(import.meta.url))),
	control_input_sha256: sha256(fs.readFileSync(path.join(run, "input.jsonl"))),
	selector_module_sha256: sha256(fs.readFileSync(moduleFile)),
	...(options["source-map"] ? { source_map_sha256: sha256(fs.readFileSync(options["source-map"])) } : {}),
	search_module_sha256: sha256(
		fs.readFileSync(path.join(root, "packages/memory-store/dist/search/unified-search.js")),
	),
	selected_ids: records.map((record) => record.id),
	model,
	provider,
	allow_fallbacks: false,
	reasoning_effort: "none",
	official_prompts_changed: false,
	intervention: `actual core ${intervention} context only; fixed Top12 IDs, ordering and scores`,
	...(intervention === "dialogue" ? { max_added_original_utf16_characters: 16000 } : {}),
};
fs.mkdirSync(path.join(output, "selection-checkpoints"), { recursive: true });
const manifest = path.join(output, "ablation-manifest.json");
if (fs.existsSync(manifest))
	assert.deepEqual(JSON.parse(fs.readFileSync(manifest, "utf8")), identity, "Changed ablation identity");
else fs.writeFileSync(manifest, `${JSON.stringify(identity, null, 2)}\n`);
const completed = [];
try {
	for (const record of records) {
		const checkpoint = path.join(output, "selection-checkpoints", `${sha256(record.id)}.json`);
		if (fs.existsSync(checkpoint)) {
			completed.push(JSON.parse(fs.readFileSync(checkpoint, "utf8")));
			continue;
		}
		const trace = traces.get(record.id);
		assert(trace, `Missing trace ${record.id}`);
		const fused = new Map(trace.before_rerank.map((hit) => [hit.id, hit]));
		const hits = trace.after_rerank.map((hit) => {
			assert(fused.has(hit.id), "Final evidence missing from frozen pool");
			const hydrated = hydrateHit(
				fused.get(hit.id),
				trace.user_id,
				(id) => parentQuery.get(id),
				(id) => chunkQuery.get(id),
			);
			return { ...hydrated, similarity: hit.score };
		});
		const deps = {
			embedQuery: async () => [1],
			searchRawMessagesAnn: async () => structuredClone(hits),
			searchRawMessagesLexical: async () => [],
			reranker: { rerank: async () => trace.after_rerank.map((hit) => ({ id: hit.id, score: hit.score })) },
		};
		const input = {
			userId: trace.user_id,
			query: trace.query,
			sources: ["memory"],
			limit: trace.top_k,
			includeRetrievalDiagnostics: true,
		};
		const baseline = await createUnifiedSearch(deps).search(input);
		assert.deepEqual(
			baseline.results.map((hit) => hit.id),
			trace.after_rerank.map((hit) => hit.id),
			"Fixed ranking replay differs",
		);
		assert.deepEqual(
			baseline.results.map((hit) => hit.content),
			record.retrieved_context,
			"Full original context replay differs",
		);
		let requestCount = 0;
		const complete = async (prompt) => {
			const requestId = ++requestCount;
			const started = Date.now();
			const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST",
				signal: AbortSignal.timeout(120000),
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
				},
				body: JSON.stringify({
					model,
					provider: { order: [provider], allow_fallbacks: false },
					reasoning: { effort: "none" },
					temperature: 0,
					messages: [{ role: "user", content: prompt }],
				}),
			});
			const payload = await response.json();
			const valid =
				response.ok &&
				payload.provider?.toLowerCase() === provider.toLowerCase() &&
				typeof payload.choices?.[0]?.message?.content === "string";
			fs.appendFileSync(
				path.join(output, "selection-requests.jsonl"),
				`${JSON.stringify({ id: record.id, request: requestId, status: valid ? "success" : "error", requested_provider: provider, provider: payload.provider, model: payload.model, http_status: response.status, elapsed_ms: Date.now() - started, usage: payload.usage })}\n`,
			);
			if (!valid) throw new Error("Selection transport/provider validation failed");
			return payload.choices[0].message.content;
		};
		const changed = await createUnifiedSearch({
			...deps,
			...(intervention === "extractive"
				? { reasoning: { evidenceSelector: coreIntervention.createExtractiveEvidenceSelector({ complete }) } }
				: {
						dialogueContext: {
							loadPairs: (input) => catalog.getRawMessageDialoguePairs(input),
							maxAddedCharacters: 16000,
						},
					}),
		}).search(input);
		assert.deepEqual(
			changed.results.map((hit) => hit.id),
			baseline.results.map((hit) => hit.id),
			"Selection changed IDs or ranking",
		);
		assert.deepEqual(
			changed.results.map((hit) => hit.similarity),
			baseline.results.map((hit) => hit.similarity),
			"Selection changed scores",
		);
		const row = {
			record: { ...record, retrieved_context: changed.results.map((hit) => hit.content) },
			trace: {
				...trace,
				original_after_rerank: trace.after_rerank,
				after_rerank: changed.results.map((hit, index) => ({
					...trace.after_rerank[index],
					content_sha256: sha256(hit.content),
					content_excerpt: hit.content.slice(0, 300),
					matched_spans: (hit.metadata.matchedSpans ?? []).map((span) => ({
						start_position: span.startPosition,
						end_position: span.endPosition,
						source_chunk_ids: span.sourceChunkIds ?? [],
						channels: span.channels,
						content_sha256: sha256(span.content),
					})),
				})),
				search_response: changed.results.map((hit) => ({
					id: hit.id,
					content: hit.content,
					score: hit.similarity,
				})),
				evidence_selection: changed.results.map((hit) => ({
					id: hit.id,
					audit: hit.metadata.contextSelection,
					selected_spans: hit.metadata.matchedSpans,
				})),
				evidence_selection_warnings: changed.warnings,
				...(intervention === "dialogue"
					? {
							dialogue_context: (() => {
								const sourceMap = sourceMaps.get(trace.user_id);
								assert(sourceMap, `Missing user source map ${trace.user_id}`);
								const neighbors = changed.results.flatMap((hit) =>
									(hit.dialogueContextMessages ?? []).map((message) => {
										const source = sourceMap[message.id];
										assert(source, `Unmapped neighbor ${message.id}`);
										const original = parentQuery.get(message.id);
										assert.equal(original.user_id, trace.user_id);
										assert.equal(
											original.content,
											message.content,
											"Neighbor text differs from stored original",
										);
										return {
											anchor_id: hit.id,
											id: message.id,
											source_turn_id: source,
											role: message.role,
											message_sequence: message.messageSequence,
											start_position: message.startPosition,
											end_position: message.endPosition,
											content_sha256: sha256(message.content),
											character_count: message.content.length,
											...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
										};
									}),
								);
								const direct = new Set(trace.after_rerank.flatMap((hit) => hit.source_turn_ids ?? []));
								const expanded = new Set([...direct, ...neighbors.map((message) => message.source_turn_id)]);
								const required = trace.required_source_turn_ids ?? [];
								return {
									neighbors,
									direct_source_turn_ids: [...direct],
									expanded_source_turn_ids: [...expanded],
									direct_source_recall: required.length
										? required.filter((id) => direct.has(id)).length / required.length
										: null,
									expanded_source_recall: required.length
										? required.filter((id) => expanded.has(id)).length / required.length
										: null,
									added_original_characters: neighbors.reduce(
										(sum, message) => sum + message.character_count,
										0,
									),
									warnings: changed.warnings,
								};
							})(),
						}
					: {}),
			},
		};
		fs.writeFileSync(`${checkpoint}.tmp`, JSON.stringify(row));
		fs.renameSync(`${checkpoint}.tmp`, checkpoint);
		completed.push(row);
		process.stdout.write(
			`[evidence-ablation] ${completed.length}/${records.length} ${record.id}; selected=${changed.results.filter((hit) => hit.metadata.contextSelection?.status === "selected").length}; fallbacks=${changed.warnings.length}\n`,
		);
	}
	for (const [name, field] of [
		["input.jsonl", "record"],
		["retrieval-traces.jsonl", "trace"],
	]) {
		fs.writeFileSync(
			path.join(output, `${name}.tmp`),
			`${completed.map((row) => JSON.stringify(row[field])).join("\n")}\n`,
		);
		fs.renameSync(path.join(output, `${name}.tmp`), path.join(output, name));
	}
} finally {
	db.close();
}
