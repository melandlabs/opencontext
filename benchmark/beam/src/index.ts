/**
 * BEAM Benchmark CLI
 *
 * Run via:
 *   pnpm --filter @melandlabs/benchmark-beam benchmark -- \
 *     --dataset dataset/beam_1m.json \
 *     --output results/beam_1m_$(date +%Y%m%d_%H%M%S).json
 *
 * Or, to demo the OpenContext claim subset:
 *   pnpm --filter @melandlabs/benchmark-beam benchmark -- \
 *     --dataset dataset/beam_1m.json \
 *     --type ku,pf,cr,mr --conversations 5
 */

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	getManifestPath,
	runPreflight,
	sumTokenUsage,
	unavailableTokenUsage,
	writeRunManifest,
} from "../../run-support";
import { expandBeamSamples, loadBeamDatasetFromJson } from "./dataset";
import { BeamEvaluator, RETRIEVAL_LIMIT } from "./evaluator";
import {
	JUDGE_MODEL,
	type NuggetCategoryMetrics,
	calculateNuggetCategoryMetrics,
} from "./metrics";
import {
	checkOpencontextHealth,
	getAnswererModelIdentity,
	getOpencontextBaseUrl,
} from "./opencontext-client";
import {
	OPENCONTEXT_CLAIM_MAP,
	OPENCONTEXT_HIGHLIGHT_CATEGORIES,
	QUESTION_TYPES,
	QUESTION_TYPE_NAMES,
} from "./scorer";
import type { BeamQuestionCategory, BeamScale, EvaluationResult, Prediction } from "./types";

interface CliArgs {
	dataset: string;
	conversations?: number;
	questionsPerConv?: number;
	types?: BeamQuestionCategory[];
	scale?: BeamScale;
	quick?: boolean;
	output?: string;
	port?: number;
	resume: boolean;
	parameterErrors: string[];
}

function parseCsv<T extends string>(
	raw: string | undefined,
	valid: Set<T>,
	option: string,
	errors: string[],
): T[] | undefined {
	if (!raw) return undefined;
	const parts = raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (parts.length === 0) return undefined;
	const out: T[] = [];
	for (const part of parts) {
		if (!valid.has(part as T)) {
			errors.push(`${option} contains an unknown value: ${part}`);
			continue;
		}
		out.push(part as T);
	}
	return out.length > 0 ? out : undefined;
}

function parseCliArgs(): CliArgs {
	const args = process.argv.slice(2);
	const values: Record<string, string | boolean | undefined> = {
		quick: false,
		resume: true,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--dataset" || arg === "-d") {
			values.dataset = args[++i] as string;
		} else if (arg === "--conversations" || arg === "-c") {
			values.conversations = args[++i] as string;
		} else if (arg === "--questions-per-conv" || arg === "-qpc") {
			values.questionsPerConv = args[++i] as string;
		} else if (arg === "--type" || arg === "-t") {
			values.types = args[++i] as string;
		} else if (arg === "--scale") {
			values.scale = args[++i] as string;
		} else if (arg === "--quick") {
			values.quick = true;
		} else if (arg === "--output" || arg === "-o") {
			values.output = args[++i] as string;
		} else if (arg === "--port" || arg === "-p") {
			values.port = args[++i] as string;
		} else if (arg === "--resume") {
			values.resume = true;
		} else if (arg === "--no-resume") {
			values.resume = false;
		} else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}
	}

	if (!values.dataset) {
		printHelp();
		process.exit(1);
	}

	const typeSet = new Set<BeamQuestionCategory>(QUESTION_TYPES);
	const scaleSet = new Set<BeamScale>(["128k", "500k", "1m", "10m"]);
	const parameterErrors: string[] = [];

	const conversations = values.conversations
		? Number.parseInt(values.conversations as string, 10)
		: undefined;
	const questionsPerConv = values.questionsPerConv
		? Number.parseInt(values.questionsPerConv as string, 10)
		: undefined;

	return {
		dataset: values.dataset as string,
		conversations,
		questionsPerConv,
		types: parseCsv<BeamQuestionCategory>(values.types as string, typeSet, "--type", parameterErrors),
		scale: parseCsv<BeamScale>(values.scale as string, scaleSet, "--scale", parameterErrors)?.[0],
		quick: values.quick as boolean,
		output: values.output as string | undefined,
		port: values.port ? Number.parseInt(values.port as string, 10) : undefined,
		resume: values.resume !== false,
		parameterErrors,
	};
}

function printHelp(): void {
	console.log(`BEAM Benchmark CLI

Usage:
  pnpm --filter @melandlabs/benchmark-beam benchmark -- \\
    --dataset <path.json> [options]

Required:
  -d, --dataset <path>             Path to BEAM JSON dataset (one per scale)

Filter:
  -c, --conversations <n>          Cap on number of conversations to run
  -qpc, --questions-per-conv <n>   Cap on probing questions per conversation
  -t, --type <csv>                 Filter categories (csv of:
                                   abstention, contradiction_resolution,
                                   event_ordering, information_extraction,
                                   instruction_following, knowledge_update,
                                   multi_session_reasoning,
                                   preference_following, summarization,
                                   temporal_reasoning)
      --scale <128k|500k|1m|10m>   Validate the dataset scale tag

Mode:
      --quick                       First 5 questions only (smoke test)
      --resume / --no-resume        Reuse cached judge results (default: resume)

API:
  -p, --port <n>                   OpenContext memory daemon port (default: 7421,
                                   env: OPENCONTEXT_PORT / OPENCONTEXT_URL)

Output:
  -o, --output <path>              Write results JSON to this path

Examples:
  # Smoke test (sample_conversation.json ships with the repo)
  pnpm benchmark -- --dataset dataset/sample_conversation.json

  # OpenContext claim subset, 5 conversations
  pnpm benchmark -- --dataset dataset/beam_1m.json \\
    --type knowledge_update,preference_following,contradiction_resolution,multi_session_reasoning \\
    --conversations 5

  # Full 1M run
  pnpm benchmark -- --dataset dataset/beam_1m.json \\
    --output results/beam_1m_$(date +%Y%m%d_%H%M%S).json
`);
}

function printSummary(
	predictionsByCategory: Record<BeamQuestionCategory, Prediction[]>,
	args: CliArgs,
): void {
	console.log("=".repeat(80));
	console.log("BEAM Evaluation Results Summary");
	console.log("=".repeat(80));

	const all: Prediction[] = [];
	for (const preds of Object.values(predictionsByCategory)) {
		all.push(...preds);
	}

	const overall = calculateNuggetCategoryMetrics(all);
	console.log("\n📊 Overall Results:");
	console.log(`  Total Questions:    ${overall.count}`);
	console.log(`  Nugget Mean:        ${overall.nugget_mean.toFixed(4)}`);
	console.log(
		`  Pass Rate (≥0.5):   ${overall.nugget_pass_rate.toFixed(4)} (${overall.nugget_pass_count}/${overall.count})`,
	);
	console.log(`  Abstentions:        ${overall.abstention_count}`);

	console.log(`\n${"=".repeat(80)}`);
	console.log("Results by BEAM Category");
	console.log("=".repeat(80));

	// Print in the canonical BEAM order, not insertion order.
	for (const category of QUESTION_TYPES) {
		const preds = predictionsByCategory[category];
		if (!preds || preds.length === 0) continue;
		const m: NuggetCategoryMetrics = calculateNuggetCategoryMetrics(preds);
		console.log(`\n${category} (${QUESTION_TYPE_NAMES[category]}):`);
		console.log(`  OpenContext claim: ${OPENCONTEXT_CLAIM_MAP[category]}`);
		console.log(`  Count:         ${m.count}`);
		console.log(`  Nugget Mean:   ${m.nugget_mean.toFixed(4)}`);
		console.log(`  Pass Rate:     ${m.nugget_pass_rate.toFixed(4)} (${m.nugget_pass_count}/${m.count})`);
		console.log(`  Abstentions:   ${m.abstention_count}`);
	}

	console.log(`\n${"=".repeat(80)}`);
	console.log("OpenContext Highlight Subset (--type ku,pf,cr,mr)");
	console.log("=".repeat(80));
	const highlight: Prediction[] = [];
	for (const c of OPENCONTEXT_HIGHLIGHT_CATEGORIES) {
		const preds = predictionsByCategory[c];
		if (preds) highlight.push(...preds);
	}
	if (highlight.length > 0) {
		const m = calculateNuggetCategoryMetrics(highlight);
		console.log(`  Count:         ${m.count}`);
		console.log(`  Nugget Mean:   ${m.nugget_mean.toFixed(4)}`);
		console.log(`  Pass Rate:     ${m.nugget_pass_rate.toFixed(4)} (${m.nugget_pass_count}/${m.count})`);
	} else {
		console.log(
			"  (no questions in this subset — re-run with --type knowledge_update,preference_following,contradiction_resolution,multi_session_reasoning)",
		);
	}

	console.log(`\n${"=".repeat(80)}\n`);
}

async function main() {
	const startedAt = new Date().toISOString();
	const args = parseCliArgs();
	const baseUrl = args.port ? `http://127.0.0.1:${args.port}` : getOpencontextBaseUrl();
	const benchmarkDir = join(import.meta.dirname, "..");
	const manifestPath = getManifestPath(args.output, benchmarkDir, startedAt);
	let conversations: Awaited<ReturnType<typeof loadBeamDatasetFromJson>> = [];
	let activeSamples: ReturnType<typeof expandBeamSamples> = [];
	if (
		args.conversations !== undefined &&
		(!Number.isInteger(args.conversations) || args.conversations < 1)
	) {
		args.parameterErrors.push("--conversations must be a positive integer");
	}
	if (
		args.questionsPerConv !== undefined &&
		(!Number.isInteger(args.questionsPerConv) || args.questionsPerConv < 1)
	) {
		args.parameterErrors.push("--questions-per-conv must be a positive integer");
	}
	if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535)) {
		args.parameterErrors.push("--port must be an integer between 1 and 65535");
	}

	await runPreflight({
		datasetPath: args.dataset,
		writablePaths: [
			manifestPath,
			join(benchmarkDir, "checkpoints", "beam", ".preflight"),
			...(args.output ? [args.output] : []),
		],
		parameterErrors: args.parameterErrors,
		validateDataset: async () => {
			conversations = await loadBeamDatasetFromJson(args.dataset, {
				conversations: args.conversations,
				questionsPerConv: args.questionsPerConv,
				types: args.types,
				assertScale: args.scale,
			});
			activeSamples = expandBeamSamples(conversations);
			if (args.quick) activeSamples = activeSamples.slice(0, 5);
			if (conversations.length === 0 || activeSamples.length === 0) {
				throw new Error(
					"no questions remain after applying --type/--scale/--conversations/--questions-per-conv",
				);
			}
		},
		checkDaemon: () => checkOpencontextHealth(baseUrl),
	});
	console.log(`🔌 OpenContext memory daemon: ${baseUrl}`);
	console.log(`\n📁 Loaded dataset from: ${args.dataset}`);

	console.log(`📊 Loaded ${conversations.length} BEAM conversations`);
	if (args.types) {
		console.log(`   → filtered to categories: ${args.types.join(", ")}`);
	}
	console.log();

	if (args.quick) {
		console.log(`⚡ Quick mode: limiting to first ${activeSamples.length} questions`);
	}
	console.log(`🎯 Evaluating ${activeSamples.length} questions\n`);

	const predictionsByCategory: Record<BeamQuestionCategory, Prediction[]> = {
		abstention: [],
		contradiction_resolution: [],
		event_ordering: [],
		information_extraction: [],
		instruction_following: [],
		knowledge_update: [],
		multi_session_reasoning: [],
		preference_following: [],
		summarization: [],
		temporal_reasoning: [],
	};

	let lastConvEntryId = "";
	let chunkCount = 0;

	for (const sample of activeSamples) {
		const evaluator = new BeamEvaluator(baseUrl, undefined, args.resume);

		try {
			// Re-load conversation if we moved to a new one
			if (sample.conversation.entry_id !== lastConvEntryId) {
				chunkCount = await evaluator.loadConversation(sample.conversation);
				lastConvEntryId = sample.conversation.entry_id;
			}

			const pred = await evaluator.evaluateQuestion(sample.conversation, sample.question, chunkCount);
			predictionsByCategory[pred.category].push(pred);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`Error on ${sample.question.question_id}: ${errorMessage}`);

			const failedPred: Prediction = {
				token_usage: unavailableTokenUsage(),
				question_id: sample.question.question_id,
				question: sample.question.question,
				response: `Error: ${errorMessage}`,
				prediction: `Error: ${errorMessage}`,
				atoms: sample.question.atoms,
				category: sample.question.category,
				scale: sample.conversation.scale,
				nugget_scores: sample.question.atoms.map(() => 0),
				nugget_mean: 0,
				nugget_pass: false,
				judge_reasoning: `agent failure: ${errorMessage}`,
				abstained: false,
			};
			predictionsByCategory[failedPred.category].push(failedPred);
		}
	}

	printSummary(predictionsByCategory, args);

	// Build per-entry EvaluationResult array for the JSON output
	const perEntry = new Map<string, EvaluationResult>();
	for (const preds of Object.values(predictionsByCategory)) {
		for (const p of preds) {
			const conv = conversations.find((c) =>
				c.probing_questions.some((q) => q.question_id === p.question_id),
			);
			if (!conv) continue;
			const existing = perEntry.get(conv.entry_id);
			if (!existing) {
				perEntry.set(conv.entry_id, {
					entry_id: conv.entry_id,
					scale: conv.scale,
					total_questions: 0,
					correct_answers: 0,
					nugget_mean: 0,
					nugget_pass_rate: 0,
					token_usage: unavailableTokenUsage(),
					predictions: [],
				});
			}
			const entry = perEntry.get(conv.entry_id);
			if (!entry) continue;
			entry.predictions.push(p);
			entry.total_questions += 1;
			if (p.nugget_pass) entry.correct_answers += 1;
		}
	}
	for (const entry of Array.from(perEntry.values())) {
		const m = calculateNuggetCategoryMetrics(entry.predictions);
		entry.nugget_mean = m.nugget_mean;
		entry.nugget_pass_rate = m.nugget_pass_rate;
		entry.token_usage = sumTokenUsage(entry.predictions.map((prediction) => prediction.token_usage));
	}

	const predictions = Object.values(predictionsByCategory).flat();
	const runTokenUsage = sumTokenUsage(predictions.map((prediction) => prediction.token_usage));
	const finishedAt = new Date().toISOString();
	const runManifest = await writeRunManifest(manifestPath, {
		benchmark: "beam",
		datasetPath: args.dataset,
		answerer_model: getAnswererModelIdentity(),
		judge_model: JUDGE_MODEL,
		retrieval: { strategy: "memory-search", top_k: RETRIEVAL_LIMIT },
		resume: args.resume,
		started_at: startedAt,
		finished_at: finishedAt,
		token_usage: runTokenUsage,
		parameters: {
			conversations: args.conversations ?? null,
			questions_per_conversation: args.questionsPerConv ?? null,
			categories: args.types ?? null,
			scale: args.scale ?? null,
			quick: args.quick ?? false,
		},
	});
	const output = {
		dataset: args.dataset,
		scale: args.scale,
		conversations_run: conversations.length,
		questions_run: activeSamples.length,
		categories_filter: args.types ?? null,
		summary: calculateNuggetCategoryMetrics(predictions),
		token_usage: runTokenUsage,
		run_manifest: runManifest,
		per_category: Object.fromEntries(
			QUESTION_TYPES.filter((c) => predictionsByCategory[c].length > 0).map((c) => [
				c,
				{
					opencontext_claim: OPENCONTEXT_CLAIM_MAP[c],
					...calculateNuggetCategoryMetrics(predictionsByCategory[c]),
				},
			]),
		),
		per_entry: Array.from(perEntry.values()),
		predictions,
	};

	if (args.output) {
		await mkdir(dirname(resolve(args.output)), { recursive: true });
		await writeFile(args.output, JSON.stringify(output, null, 2), "utf-8");
		console.log(`💾 Results saved to: ${args.output}`);
	}
	console.log(`🧾 Run manifest saved to: ${manifestPath}`);

	return output;
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
