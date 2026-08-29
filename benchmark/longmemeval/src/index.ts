/**
 * LongMemEval Benchmark CLI
 *
 * Run via: pnpm benchmark:longmemeval -- --dataset dataset/longmemeval_s_cleaned.json --quick
 */

import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { loadLongMemEvalDatasetFromJson } from "./dataset";
import { LongMemEvalEvaluator } from "./evaluator";
import { JUDGE_MODEL, calculateCategoryMetrics } from "./metrics";
import {
	checkOpencontextHealth,
	getAnswererModelIdentity,
	getOpencontextBaseUrl,
} from "./opencontext-client";
import { QUESTION_TYPE_NAMES } from "./scorer";
import type { Prediction } from "./types";

interface CliArgs {
	dataset: string;
	samples?: string[];
	quick?: boolean;
	output?: string;
	port?: number;
	resume: boolean;
}

function parseCliArgs(): CliArgs {
	const args = process.argv.slice(2);
	const values: Record<string, string | boolean | number | string[] | undefined> = {
		quick: false,
		resume: true,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--dataset" || arg === "-d") {
			values.dataset = args[++i];
		} else if (arg === "--samples" || arg === "-s") {
			values.samples = args[++i];
		} else if (arg === "--quick" || arg === "-q") {
			values.quick = true;
		} else if (arg === "--output" || arg === "-o") {
			values.output = args[++i];
		} else if (arg === "--port" || arg === "-p") {
			values.port = Number.parseInt(args[++i], 10);
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

	let samples: string[] | undefined;
	if (values.samples) {
		samples = (values.samples as string).split(",").map((s: string) => s.trim());
	}

	return {
		dataset: values.dataset as string,
		samples,
		quick: values.quick as boolean,
		output: values.output as string | undefined,
		port: values.port as number | undefined,
		resume: values.resume !== false,
	};
}

function printHelp(): void {
	// biome-ignore lint/suspicious/noConsole: CLI help is intentionally written to stdout
	console.log(`LongMemEval Benchmark CLI

Usage:
  pnpm benchmark -- --dataset <path.json> [options]

Required:
  -d, --dataset <path>        Path to LongMemEval JSON dataset

Filter:
  -s, --samples <csv>         Filter to question IDs (csv)
  -q, --quick                 Run the first 5 entries

Mode:
      --resume / --no-resume  Reuse cached judge results (default: resume)

API:
  -p, --port <n>              OpenContext memory daemon port (default: 7421,
                              env: OPENCONTEXT_PORT / OPENCONTEXT_URL)

Output:
  -o, --output <path>         Write results JSON to this path
`);
}

async function printEvaluationSummary(resultsByType: Record<string, Prediction[]>): Promise<void> {
	// Calculate overall metrics
	const allResults: Prediction[] = [];
	for (const [, results] of Object.entries(resultsByType)) {
		allResults.push(...results);
	}

	const _overallMetrics = calculateCategoryMetrics(allResults);

	for (const [qtype, results] of Object.entries(resultsByType).sort()) {
		const _metrics = calculateCategoryMetrics(results);
		const _typeName = QUESTION_TYPE_NAMES[qtype] || qtype;
	}
}

async function main() {
	const args = parseCliArgs();

	// Resolve the OpenContext memory daemon and verify it is up
	const baseUrl = args.port ? `http://127.0.0.1:${args.port}` : getOpencontextBaseUrl();
	try {
		await checkOpencontextHealth(baseUrl);
	} catch (_error) {
		process.exit(1);
	}
	const entries = await loadLongMemEvalDatasetFromJson(args.dataset);

	// Filter entries if sample_ids provided
	let filteredEntries = entries;
	if (args.samples && args.samples.length > 0) {
		filteredEntries = entries.filter((e) => args.samples?.includes(e.question_id));
	}

	// Apply quick mode (first 5 entries only)
	if (args.quick) {
		filteredEntries = filteredEntries.slice(0, 5);
	}

	// Run evaluation
	const allPredictionsByType: Record<string, Prediction[]> = {};
	let correct = 0;
	let total = 0;

	for (const entry of filteredEntries) {
		const evaluator = new LongMemEvalEvaluator(baseUrl, undefined, args.resume);

		try {
			// Ingest entry into the memory store
			await evaluator.loadEntry(entry);

			// Evaluate question
			const pred = await evaluator.evaluateQuestion(entry);

			// Organize predictions by question type
			const qtype = pred.question_type;
			if (!allPredictionsByType[qtype]) {
				allPredictionsByType[qtype] = [];
			}
			allPredictionsByType[qtype].push(pred);

			if (pred.correct) {
				correct++;
			}
			total++;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);

			// Record failed prediction
			const failedPred: Prediction = {
				status: "execution_error",
				attempt: 1,
				answerer_model: getAnswererModelIdentity(),
				judge_model: JUDGE_MODEL,
				error: errorMessage,
				question: entry.question,
				answer: entry.answer,
				response: `Error: ${errorMessage}`,
				prediction: `Error: ${errorMessage}`,
				ground_truth: entry.answer,
				question_type: entry.question_type,
				llm_score: 0,
				correct: false,
				f1_score: 0.0,
				bleu_score: 0.0,
				bleu1: 0.0,
				bleu2: 0.0,
				bleu3: 0.0,
				bleu4: 0.0,
				evidence_session_ids: entry.answer_session_ids,
			};

			const qtype = entry.question_type;
			if (!allPredictionsByType[qtype]) {
				allPredictionsByType[qtype] = [];
			}
			allPredictionsByType[qtype].push(failedPred);
			total++;
		}
	}

	// Print summary
	await printEvaluationSummary(allPredictionsByType);

	// Prepare output
	const overallAccuracy = total > 0 ? correct / total : 0;

	const output = {
		num_entries: filteredEntries.length,
		total_questions: total,
		total_correct: correct,
		overall_accuracy: overallAccuracy,
		results_by_type: Object.fromEntries(
			Object.entries(allPredictionsByType).map(([qtype, preds]) => {
				const metrics = calculateCategoryMetrics(preds);
				return [
					qtype,
					{
						count: metrics.count,
						accuracy: metrics.llm_judge_accuracy,
						f1_mean: metrics.f1_mean,
						bleu1_mean: metrics.bleu1_mean,
						bleu4_mean: metrics.bleu4_mean,
						predictions: preds.map((p) => ({
							question_id: p.question.slice(0, 50),
							correct: p.correct,
							llm_score: p.llm_score,
							f1_score: p.f1_score,
						})),
					},
				];
			}),
		),
		predictions: Object.values(allPredictionsByType).flat(),
	};

	// Save output if requested
	if (args.output) {
		await writeFile(args.output, JSON.stringify(output, null, 2), "utf-8");
	}

	return output;
}

main().catch(console.error);
