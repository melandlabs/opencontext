/**
 * Library-mode ScriptMem retrieval for OpenContext (replaces retrieve.py's
 * HTTP search for scriptmem) so reasoning enhancements that the daemon does
 * not expose (query rewriting / iterative multi-step recall / RRF fusion)
 * can be benchmarked.
 *
 * Ingestion is NOT repeated here — the `_real` script chunks are already in
 * the store (see retrieve.py run_scriptmem). This script only re-runs the
 * per-question retrieval and emits the exact same input.jsonl schema.
 *
 * Usage:
 *   node aml-lib-search.mjs [--strategy iterative|rewrite|none]
 *                           [--merge rrf|similarity]
 *                           [--out scriptmem-iterative]
 *                           [--top-k 10] [--concurrency 8]
 *                           [--limit N] [--max-questions N]
 *
 * Env (falls back to benchmark/aml-local/.env):
 *   OPENCONTEXT_DB_PATH       default <repo>/benchmark/.opencontext-data/memory/store.db
 *   OPENCONTEXT_LLM_API_KEY   (or OPENROUTER_API_KEY) — required for rewrite/iterative
 *   OPENCONTEXT_LLM_BASE_URL  default https://openrouter.ai/api/v1
 *   OPENCONTEXT_LLM_MODEL     default openai/gpt-4o-mini
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	createIterativeRecallPlanner,
	createMemoryStore,
	createUserVoiceRewriter,
} from "../../packages/memory-store/dist/index.js";
import { LocalTransformersEmbeddingProvider } from "../../packages/ai/rag/dist/local-transformers-embedding-provider.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(HERE, "..");
const SCRIPTMEM_DIR = path.join(BENCH_ROOT, "scriptmem", "dataset", "raw");
const SCRIPTMEM_FILES = ["angry.json", "enemy.json", "friends.json", "man_earth.json"];
const SCRIPTMEM_TITLES = {
	angry: "12 Angry Men",
	enemy: "An Enemy of the People",
	friends: "Friends",
	man_earth: "The Man from Earth",
};

// ------------------------------------------------------------ env / args

function loadDotEnv(file) {
	if (!fs.existsSync(file)) return;
	for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
		if (!m || line.trim().startsWith("#")) continue;
		const key = m[1];
		let value = m[2].replace(/^["']|["']$/g, "");
		if (!(key in process.env)) process.env[key] = value;
	}
}
loadDotEnv(path.join(HERE, ".env"));

function parseArgs(argv) {
	const args = {
		strategy: "iterative",
		merge: "rrf",
		out: null,
		topK: Number.parseInt(process.env.AML_TOP_K ?? "10", 10),
		concurrency: 8,
		limit: null,
		maxQuestions: null,
	};
	for (let i = 2; i < argv.length; i += 2) {
		const key = argv[i];
		const value = argv[i + 1];
		switch (key) {
			case "--strategy":
				args.strategy = value;
				break;
			case "--merge":
				args.merge = value;
				break;
			case "--out":
				args.out = value;
				break;
			case "--top-k":
				args.topK = Number.parseInt(value, 10);
				break;
			case "--concurrency":
				args.concurrency = Number.parseInt(value, 10);
				break;
			case "--limit":
				args.limit = Number.parseInt(value, 10);
				break;
			case "--max-questions":
				args.maxQuestions = Number.parseInt(value, 10);
				break;
			default:
				throw new Error(`unknown arg: ${key}`);
		}
	}
	if (!args.out) args.out = `scriptmem-${args.strategy}`;
	return args;
}

const args = parseArgs(process.argv);

// ------------------------------------------------------------ LLM complete

const LLM_API_KEY = process.env.OPENCONTEXT_LLM_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "";
const LLM_BASE_URL = (process.env.OPENCONTEXT_LLM_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
const LLM_MODEL = process.env.OPENCONTEXT_LLM_MODEL ?? "openai/gpt-4o-mini";

async function complete(prompt) {
	if (!LLM_API_KEY) throw new Error("OPENCONTEXT_LLM_API_KEY (or OPENROUTER_API_KEY) is required for reasoning strategies");
	let lastError = null;
	for (let attempt = 0; attempt < 3; attempt++) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 60000);
		try {
			const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${LLM_API_KEY}`,
				},
				body: JSON.stringify({
					model: LLM_MODEL,
					messages: [{ role: "user", content: prompt }],
					temperature: 0,
				}),
				signal: controller.signal,
			});
			if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 300)}`);
			const body = await res.json();
			const text = body?.choices?.[0]?.message?.content;
			if (typeof text === "string" && text.trim()) return text.trim();
			lastError = new Error("llm returned empty content");
		} catch (error) {
			lastError = error;
		} finally {
			clearTimeout(timeout);
		}
	}
	throw lastError ?? new Error("llm call failed");
}

// ------------------------------------------------------------ store wiring

const DB_PATH =
	process.env.OPENCONTEXT_DB_PATH ?? path.join(BENCH_ROOT, ".opencontext-data", "memory", "store.db");

const embeddingProvider = new LocalTransformersEmbeddingProvider({});
const holder = { manager: null };

const store = await createMemoryStore({
	dbPath: DB_PATH,
	unified: {
		embedQuery: async ({ query }) => embeddingProvider.embedQuery(query),
		searchRawMessagesAnn: async ({ userId, queryEmbedding, limit, threshold, botId }) => {
			const rows = await holder.manager.searchMessagesSemantically({
				userId,
				queryEmbedding,
				limit,
				threshold,
				botId,
			});
			return rows.map((r) => ({
				id: r.id,
				content: r.content,
				similarity: r.similarity,
				metadata: r.metadata ?? {},
			}));
		},
		searchRawMessagesLexical: async (input) => {
			if (typeof holder.manager.lexicalSearchMessages !== "function") return [];
			const results = await holder.manager.lexicalSearchMessages(input);
			return results
				.filter(Boolean)
				.map((r) => ({
					type: "memory",
					id: r.id,
					content: r.content,
					similarity: r.similarity,
					metadata: r.metadata ?? {},
				}));
		},
		reasoning: {
			complete,
			queryRewriter: createUserVoiceRewriter({ complete, maxVariants: 1 }),
			iterativePlanner: createIterativeRecallPlanner({
				complete,
				options: {
					maxIterations: Number.parseInt(process.env.OPENCONTEXT_LLM_REASONING_MAX_ITERATIONS ?? "4", 10),
					searchTopK: Number.parseInt(process.env.OPENCONTEXT_LLM_REASONING_SEARCH_TOP_K ?? "5", 10),
				},
			}),
		},
	},
});
holder.manager = await store.raw.getManager();
console.warn(
	`[aml-lib] db=${DB_PATH} strategy=${args.strategy} merge=${args.merge} topK=${args.topK} model=${LLM_MODEL}`,
);

// ------------------------------------------------------------ retrieval

async function searchOne(userId, question) {
	const res = await store.search({
		userId,
		query: question,
		sources: ["memory"],
		limit: args.topK,
		reasoningStrategy: args.strategy,
		mergeStrategy: args.merge,
	});
	return res.results ?? [];
}

const SEARCH_TIMEOUT_MS = Number.parseInt(process.env.AML_SEARCH_TIMEOUT_MS ?? "180000", 10);

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runPool(items, worker, concurrency) {
	const results = new Array(items.length);
	let cursor = 0;
	let done = 0;
	async function loop() {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await worker(items[index], index);
			done++;
			if (done % 25 === 0 || done === items.length) {
				console.warn(`[aml-lib] progress ${done}/${items.length}`);
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, loop));
	return results;
}

const jobs = [];
for (const filename of SCRIPTMEM_FILES) {
	const source = filename.replace(/\.json$/, "");
	let data = JSON.parse(fs.readFileSync(path.join(SCRIPTMEM_DIR, filename), "utf8"));
	if (args.limit) data = data.slice(0, args.limit);
	for (let sampleIndex = 0; sampleIndex < data.length; sampleIndex++) {
		const sample = data[sampleIndex];
		const sampleId = sample.sample_id || `${source}-${sampleIndex}`;
		const userId = `aml_scriptmem_${source}_${sampleId}_real`;
		const title = SCRIPTMEM_TITLES[source];
		const qaList = sample.qa ?? [];
		for (let i = 0; i < qaList.length; i++) {
			if (args.maxQuestions && i >= args.maxQuestions) break;
			const qa = qaList[i];
			const qaId = `${source}:${sampleId}#q${String(i).padStart(4, "0")}`;
			jobs.push({ qaId, source, userId, title, question: qa.question, qaType: qa.qa_type ?? null });
		}
	}
}
console.warn(`[aml-lib] ${jobs.length} questions queued`);

const outDir = path.join(HERE, "outputs", args.out);
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "input.jsonl");
const partialPath = path.join(outDir, "input.partial.jsonl");

// Resume: records already written to the partial file are skipped.
const doneRecords = new Map();
if (fs.existsSync(partialPath)) {
	for (const line of fs.readFileSync(partialPath, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line);
			doneRecords.set(rec.id, rec);
		} catch {
			// ignore truncated trailing line from a crashed run
		}
	}
	if (doneRecords.size) console.warn(`[aml-lib] resuming: ${doneRecords.size} records already done`);
}
const pendingJobs = jobs.filter((j) => !doneRecords.has(j.qaId));
console.warn(`[aml-lib] ${pendingJobs.length}/${jobs.length} questions to run`);

const failures = [];
const partialFd = fs.openSync(partialPath, "a");
await runPool(
	pendingJobs,
	async (job) => {
		let hits = [];
		try {
			hits = await withTimeout(searchOne(job.userId, job.question), SEARCH_TIMEOUT_MS, job.qaId);
		} catch (error) {
			failures.push({ qaId: job.qaId, error: String(error?.message ?? error) });
			console.warn(`[aml-lib] search failed for ${job.qaId}: ${error?.message ?? error}`);
		}
		const record = {
			id: job.qaId,
			qa_id: job.qaId,
			dataset: job.source,
			question: job.question,
			qa_type: job.qaType,
			speaker_1_name: job.title,
			speaker_1_memories: hits.map((h) => h.content ?? "").join("\n\n"),
			speaker_2_name: "speaker 2",
			speaker_2_memories: "",
		};
		fs.writeSync(partialFd, JSON.stringify(record) + "\n");
		doneRecords.set(record.id, record);
		return record;
	},
	args.concurrency,
);
fs.closeSync(partialFd);

const ordered = jobs.map((j) => doneRecords.get(j.qaId)).filter(Boolean);
fs.writeFileSync(outPath, ordered.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
fs.rmSync(partialPath, { force: true });
console.warn(`[aml-lib] wrote ${ordered.length} records -> ${outPath}`);
if (failures.length) {
	console.warn(`[aml-lib] WARNING: ${failures.length} searches failed (empty memories for those records)`);
}
process.exit(0);
