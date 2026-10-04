/** Fixed-candidate ablation of the actual core reranker plug-in.
 * Model requests contain only the question and verified original candidates,
 * never source annotations, rubrics, reference answers or previous answers. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hydrateHit, selectRecords, sha256 } from "./ablate_beam_reranker.mjs";

const options = {};
for (let index = 2; index < process.argv.length; index += 2)
	options[process.argv[index].replace(/^--/, "")] = process.argv[index + 1];
for (const key of ["run", "db", "root", "output", "source-map"]) assert(options[key], `Missing --${key}`);
const run = path.resolve(options.run);
const output = path.resolve(options.output);
const root = path.resolve(options.root);
assert.notEqual(run, output, "Cannot overwrite the control");
assert(process.env.OPENROUTER_API_KEY, "Missing OpenRouter credentials");
const rows = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const moduleFile = path.join(root, "packages/memory-store/dist/search/llm-reranker.js");
const searchFile = path.join(root, "packages/memory-store/dist/search/unified-search.js");
const { createEvidenceReranker } = await import(pathToFileURL(moduleFile).href);
const { createUnifiedSearch } = await import(pathToFileURL(searchFile).href);
const require = createRequire(pathToFileURL(path.join(root, "packages/sqlite/dist/raw-message-manager.js")));
const db = new (require("better-sqlite3"))(path.resolve(options.db), { readonly: true, fileMustExist: true });
const parent = db.prepare("SELECT * FROM raw_messages WHERE message_id = ?");
const chunk = db.prepare(
	"SELECT chunk_id, message_id, chunk_index, chunk_count FROM raw_message_chunks WHERE chunk_id = ?",
);
const sourceMaps = new Map(rows(options["source-map"]).map((row) => [row.user_id, row.source_ids]));
const records = selectRecords(rows(path.join(run, "input.jsonl")), 2);
const traces = new Map(rows(path.join(run, "retrieval-traces.jsonl")).map((row) => [row.question_id, row]));
const model = "deepseek/deepseek-v4-flash-0731";
const provider = "OpenInference";
const identity = {
	control: run,
	control_input_sha256: sha256(fs.readFileSync(path.join(run, "input.jsonl"))),
	control_traces_sha256: sha256(fs.readFileSync(path.join(run, "retrieval-traces.jsonl"))),
	scorer_module_sha256: sha256(fs.readFileSync(moduleFile)),
	search_module_sha256: sha256(fs.readFileSync(searchFile)),
	harness_sha256: sha256(fs.readFileSync(new URL(import.meta.url))),
	source_map_sha256: sha256(fs.readFileSync(options["source-map"])),
	selected_ids: records.map((record) => record.id),
	model,
	provider,
	reasoning_effort: "none",
	allow_fallbacks: false,
	batch_size: 6,
	score_protocol: "indexed-integer-array",
	max_request_characters: 32000,
	top_k: 12,
	intervention:
		"actual core evidence scorer only; fixed original fusion candidates and texts; original cross-encoder settings unchanged",
	official_prompts_changed: false,
};
fs.mkdirSync(path.join(output, "ranking-checkpoints"), { recursive: true });
const manifest = path.join(output, "ablation-manifest.json");
if (fs.existsSync(manifest))
	assert.deepEqual(JSON.parse(fs.readFileSync(manifest, "utf8")), identity, "Changed ablation identity");
else fs.writeFileSync(manifest, `${JSON.stringify(identity, null, 2)}\n`);
const completed = [];
const pending = [];
try {
	for (const record of records) {
		const file = path.join(output, "ranking-checkpoints", `${sha256(record.id)}.json`);
		if (fs.existsSync(file)) {
			completed.push(JSON.parse(fs.readFileSync(file, "utf8")));
			continue;
		}
		try {
			const trace = traces.get(record.id);
			assert(trace, `Missing frozen trace ${record.id}`);
			// Restore fused order, not raw per-source similarity order. The real
			// reranker receives only original IDs/text/metadata, not fixture scores.
			const hits = trace.before_rerank.map((hit, index) => ({
				...hydrateHit(
					hit,
					trace.user_id,
					(id) => parent.get(id),
					(id) => chunk.get(id),
				),
				similarity: 1 / (1 + index),
			}));
			const deps = {
				embedQuery: async () => [1],
				searchRawMessagesAnn: async () => structuredClone(hits),
				searchRawMessagesLexical: async () => [],
				reranker: {
					rerank: async () =>
						trace.after_rerank.map((hit, index) => ({ id: hit.id, score: 1 / (1 + index) })),
				},
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
				"Control ranking differs",
			);
			assert.deepEqual(
				baseline.results.map((hit) => hit.content),
				record.retrieved_context,
				"Complete control context differs",
			);
			let requestCount = 0;
			const complete = async (prompt) => {
				let lastError;
				for (let attempt = 1; attempt <= 3; attempt++) {
					const started = Date.now();
					const request = ++requestCount;
					let recorded = false;
					try {
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
							path.join(output, "ranking-requests.jsonl"),
							`${JSON.stringify({ id: record.id, request, attempt, status: valid ? "success" : "error", requested_provider: provider, provider: payload.provider, model: payload.model, http_status: response.status, finish_reason: payload.choices?.[0]?.finish_reason, elapsed_ms: Date.now() - started, usage: payload.usage, prompt_sha256: sha256(prompt) })}\n`,
						);
						recorded = true;
						if (!valid) throw new Error(`Ranking transport/provider failure (HTTP ${response.status})`);
						const content = payload.choices[0].message.content;
						fs.appendFileSync(
							path.join(output, "ranking-responses.jsonl"),
							`${JSON.stringify({ id: record.id, request, prompt_sha256: sha256(prompt), content })}\n`,
						);
						return content;
					} catch (error) {
						if (!recorded)
							fs.appendFileSync(
								path.join(output, "ranking-requests.jsonl"),
								`${JSON.stringify({ id: record.id, request, attempt, status: "error", requested_provider: provider, error_name: error?.name, elapsed_ms: Date.now() - started, prompt_sha256: sha256(prompt) })}\n`,
							);
						lastError = error;
						if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
					}
				}
				throw lastError;
			};
			const scorer = createEvidenceReranker({ complete, batchSize: 6, maxRequestCharacters: 32000 });
			const changed = await createUnifiedSearch({
				...deps,
				reranker: {
					rerank: async (request) => {
						assert.deepEqual(
							request.candidates.map((hit) => hit.id),
							trace.before_rerank.map((hit) => hit.id),
							"Candidate window changed",
						);
						request.candidates.forEach((hit, index) =>
							assert.equal(
								sha256(hit.content),
								trace.before_rerank[index].content_sha256,
								"Original scoring text changed",
							),
						);
						return scorer.rerank(request);
					},
				},
			}).search(input);
			const originalById = new Map(trace.before_rerank.map((hit) => [hit.id, hit]));
			const sourceMap = sourceMaps.get(trace.user_id);
			assert(sourceMap, `Missing canonical source map ${trace.user_id}`);
			const after = changed.results.map((hit, index) => {
				const original = originalById.get(hit.id);
				const source = sourceMap[hit.id];
				assert(original && source, `Selected evidence was not an original mapped candidate: ${hit.id}`);
				return {
					...original,
					rank: index + 1,
					score: original.score,
					reranker_score: hit.metadata.rerankerScore,
					source_turn_ids: [source],
					matched_source_turn_ids: trace.required_source_turn_ids.includes(source) ? [source] : [],
					content_sha256: sha256(hit.content),
					content_excerpt: hit.content.slice(0, 300),
				};
			});
			const retrieved = [...new Set(after.flatMap((hit) => hit.source_turn_ids))];
			const required = trace.required_source_turn_ids;
			const row = {
				record: { ...record, retrieved_context: changed.results.map((hit) => hit.content) },
				trace: {
					...trace,
					original_after_rerank: trace.after_rerank,
					after_rerank: after,
					search_response: changed.results.map((hit) => ({
						id: hit.id,
						content: hit.content,
						score: originalById.get(hit.id).score,
					})),
					reranker: { ...changed.retrievalDiagnostics.reranker, provider: "llm", model },
					retrieved_source_turn_ids: retrieved,
					mapped_final_hits: after.length,
					source_recall_at_k: required.length
						? required.filter((source) => retrieved.includes(source)).length / required.length
						: null,
				},
			};
			fs.writeFileSync(`${file}.tmp`, JSON.stringify(row));
			fs.renameSync(`${file}.tmp`, file);
			completed.push(row);
			process.stdout.write(
				`[ranking-ablation] ${completed.length}/${records.length} ${record.id}; requests=${requestCount}\n`,
			);
		} catch (error) {
			pending.push(record.id);
			fs.appendFileSync(
				path.join(output, "ranking-errors.jsonl"),
				`${JSON.stringify({ id: record.id, error: String(error), timestamp: new Date().toISOString() })}\n`,
			);
			process.stderr.write(`[ranking-ablation] ${record.id} pending: ${String(error).split("\n")[0]}\n`);
		}
	}
	fs.writeFileSync(
		path.join(output, "ranking-status.json"),
		JSON.stringify(
			{
				status: pending.length ? "pending" : "complete",
				succeeded: completed.length,
				total: records.length,
				pending_ids: pending,
			},
			null,
			2,
		),
	);
	if (!pending.length) {
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
	} else process.exitCode = 2; // Preserve successful checkpoints; never score missing rankings as zero.
} finally {
	db.close();
}
