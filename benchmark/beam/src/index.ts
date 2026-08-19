/**
 * BEAM Benchmark CLI
 *
 * Run via:
 *   pnpm --filter @melandlabs/benchmark-beam benchmark -- \
 *     --dataset dataset/beam_1m.json \
 *     --output results/beam_1m_$(date +%Y%m%d_%H%M%S).json
 *
 * Or, to demo the Alloomi claim subset:
 *   pnpm --filter @melandlabs/benchmark-beam benchmark -- \
 *     --dataset dataset/beam_1m.json \
 *     --type ku,pf,cr,mr --conversations 5
 */

import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { expandBeamSamples, loadBeamDatasetFromJson } from "./dataset";
import { BeamEvaluator } from "./evaluator";
import { type NuggetCategoryMetrics, calculateNuggetCategoryMetrics } from "./metrics";
import { checkOpencontextHealth, getOpencontextBaseUrl } from "./opencontext-client";
import {
	ALLOOMI_CLAIM_MAP,
	ALLOOMI_HIGHLIGHT_CATEGORIES,
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
}

function parseCsv<T extends string>(raw: string | undefined, valid?: Set<T>): T[] | undefined {
	if (!raw) return undefined;
	const parts = raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (parts.length === 0) return undefined;
	if (!valid) return parts as T[];
	const out: T[] = [];
	for (const part of parts) {
		if (!valid.has(part as T)) {
			console.error(`Unknown value: ${part}`);
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

	const conversations = values.conversations
		? Number.parseInt(values.conversations as string, 10)
		: undefined;
	const questionsPerConv = values.questionsPerConv
		? Number.parseInt(values.questionsPerConv as string, 10)
		: undefined;

	return {
		dataset: values.dataset as string,
		conversations: conversations !== undefined && Number.isFinite(conversations) ? conversations : undefined,
		questionsPerConv:
			questionsPerConv !== undefined && Number.isFinite(questionsPerConv) ? questionsPerConv : undefined,
		types: parseCsv<BeamQuestionCategory>(values.types as string, typeSet),
		scale: parseCsv<BeamScale>(values.scale as string, scaleSet)?.[0],
		quick: values.quick as boolean,
		output: values.output as string | undefined,
		port: values.port ? Number.parseInt(values.port as string, 10) : undefined,
		resume: values.resume !== false,
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

  # Alloomi claim subset, 5 conversations
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
		console.log(`  Alloomi claim: ${ALLOOMI_CLAIM_MAP[category]}`);
		console.log(`  Count:         ${m.count}`);
		console.log(`  Nugget Mean:   ${m.nugget_mean.toFixed(4)}`);
		console.log(`  Pass Rate:     ${m.nugget_pass_rate.toFixed(4)} (${m.nugget_pass_count}/${m.count})`);
		console.log(`  Abstentions:   ${m.abstention_count}`);
	}

	console.log(`\n${"=".repeat(80)}`);
	console.log("Alloomi Highlight Subset (--type ku,pf,cr,mr)");
	console.log("=".repeat(80));
	const highlight: Prediction[] = [];
	for (const c of ALLOOMI_HIGHLIGHT_CATEGORIES) {
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
	const args = parseCliArgs();

	// Resolve the OpenContext memory daemon and verify it is up
	const baseUrl = args.port ? `http://127.0.0.1:${args.port}` : getOpencontextBaseUrl();
	try {
		await checkOpencontextHealth(baseUrl);
		console.log(`🔌 OpenContext memory daemon: ${baseUrl}`);
	} catch (error) {
		console.error(`${error}`);
		process.exit(1);
	}

	console.log(`\n📁 Loading dataset from: ${args.dataset}`);
	const conversations = await loadBeamDatasetFromJson(args.dataset, {
		conversations: args.conversations,
		questionsPerConv: args.questionsPerConv,
		types: args.types,
		assertScale: args.scale,
	});

	if (conversations.length === 0) {
		console.error(
			"❌ No conversations remaining after filtering. Check your --type / --conversations / --questions-per-conv flags.",
		);
		process.exit(1);
	}

	console.log(`📊 Loaded ${conversations.length} BEAM conversations`);
	if (args.types) {
		console.log(`   → filtered to categories: ${args.types.join(", ")}`);
	}
	console.log();

	const samples = expandBeamSamples(conversations);
	let activeSamples = samples;
	if (args.quick) {
		activeSamples = samples.slice(0, 5);
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
					token_usage: {
						prompt_tokens: 0,
						completion_tokens: 0,
						total_tokens: 0,
					},
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
	}

	const output = {
		dataset: args.dataset,
		scale: args.scale,
		conversations_run: conversations.length,
		questions_run: activeSamples.length,
		categories_filter: args.types ?? null,
		summary: calculateNuggetCategoryMetrics(Object.values(predictionsByCategory).flat()),
		per_category: Object.fromEntries(
			QUESTION_TYPES.filter((c) => predictionsByCategory[c].length > 0).map((c) => [
				c,
				{
					alloomi_claim: ALLOOMI_CLAIM_MAP[c],
					...calculateNuggetCategoryMetrics(predictionsByCategory[c]),
				},
			]),
		),
		per_entry: Array.from(perEntry.values()),
		predictions: Object.values(predictionsByCategory).flat(),
	};

	if (args.output) {
		await writeFile(args.output, JSON.stringify(output, null, 2), "utf-8");
		console.log(`💾 Results saved to: ${args.output}`);
	}

	return output;
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
