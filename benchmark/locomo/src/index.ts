/**
 * LoCoMo Benchmark CLI
 *
 * Run via: pnpm benchmark -- --dataset dataset/locomo_v2.json --mode observation --quick
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
import { loadLoCoMoDatasetFromJson } from "./dataset";
import { LoCoMoEvaluator, RETRIEVAL_LIMIT } from "./evaluator";
import { JUDGE_MODEL, calculateCategoryMetrics } from "./metrics";
import {
	checkOpencontextHealth,
	getAnswererModelIdentity,
	getOpencontextBaseUrl,
} from "./opencontext-client";
import { CATEGORY_NAMES } from "./scorer";
import { RetrievalMode } from "./types";
import type { EvaluationResult, Prediction } from "./types";

interface CliArgs {
	dataset: string;
	mode: RetrievalMode;
	samples?: string[];
	quick?: boolean;
	output?: string;
	port?: number;
	resume: boolean;
}

function parseCliArgs(): CliArgs {
	// Simple manual argument parsing for flexibility
	const args = process.argv.slice(2);
	const values: Record<string, string | boolean | number | string[] | undefined> = {
		mode: "observation",
		quick: false,
		resume: true,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--dataset" || arg === "-d") {
			values.dataset = args[++i];
		} else if (arg === "--mode" || arg === "-m") {
			values.mode = args[++i];
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
		console.error("Error: --dataset is required");
		printHelp();
		process.exit(1);
	}

	const mode = values.mode as RetrievalMode;

	let samples: string[] | undefined;
	if (values.samples) {
		samples = (values.samples as string).split(",").map((s: string) => s.trim());
	}

	return {
		dataset: values.dataset as string,
		mode,
		samples,
		quick: values.quick as boolean,
		output: values.output as string | undefined,
		port: values.port as number | undefined,
		resume: values.resume !== false,
	};
}

function printHelp(): void {
	console.log(`LoCoMo Benchmark CLI

Usage:
  pnpm benchmark -- --dataset <path.json> [options]

Required:
  -d, --dataset <path>        Path to LoCoMo JSON dataset

Filter:
  -m, --mode <mode>           Retrieval mode: dialog, observation,
                              session_summary (default: observation)
  -s, --samples <csv>         Filter to specific sample IDs (csv)
  -q, --quick                 First 5 questions per sample (smoke test)

Mode:
      --resume / --no-resume  Reuse cached judge results (default: resume)

API:
  -p, --port <n>              OpenContext memory daemon port (default: 7421,
                              env: OPENCONTEXT_PORT / OPENCONTEXT_URL)

Output:
  -o, --output <path>         Write results JSON to this path

Examples:
  # Smoke test (locomo_v2.json ships with the repo)
  pnpm benchmark -- --dataset dataset/locomo_v2.json --quick

  # Full run, dialog mode
  pnpm benchmark -- --dataset dataset/locomo_v2.json --mode dialog \\
    --output results/locomo_$(date +%Y%m%d_%H%M%S).json
`);
}

async function printEvaluationSummary(resultsByCategory: Record<string, Prediction[]>): Promise<void> {
	console.log("=".repeat(80));
	console.log("LoCoMo Evaluation Results Summary");
	console.log("=".repeat(80));

	// Calculate overall metrics
	const allResults: Prediction[] = [];
	for (const [category, results] of Object.entries(resultsByCategory)) {
		// Skip category 5 (adversarial questions)
		if (category === "5") {
			continue;
		}
		allResults.push(...results);
	}

	const overallMetrics = calculateCategoryMetrics(allResults);

	console.log("\n📊 Overall Results:");
	console.log(`  Total Questions: ${overallMetrics.count}`);
	console.log(
		`  LLM Judge Accuracy: ${overallMetrics.llm_judge_accuracy.toFixed(4)} (${overallMetrics.llm_judge_correct}/${overallMetrics.count})`,
	);
	console.log(`  F1 Score (Mean): ${overallMetrics.f1_mean.toFixed(4)}`);
	console.log(`  BLEU-1 (Mean): ${overallMetrics.bleu1_mean.toFixed(4)}`);
	console.log(`  BLEU-4 (Mean): ${overallMetrics.bleu4_mean.toFixed(4)}`);

	console.log(`\n${"=".repeat(80)}`);
	console.log("Results by Category");
	console.log("=".repeat(80));

	for (const category of Object.keys(resultsByCategory).sort()) {
		// Skip category 5
		if (category === "5") {
			continue;
		}

		const results = resultsByCategory[category];
		const metrics = calculateCategoryMetrics(results);

		const categoryName = CATEGORY_NAMES[category] || `category_${category}`;
		console.log(`\nCategory ${category} (${categoryName}):`);
		console.log(`  Count: ${metrics.count}`);
		console.log(
			`  LLM Judge Accuracy: ${metrics.llm_judge_accuracy.toFixed(4)} (${metrics.llm_judge_correct}/${metrics.count})`,
		);
		console.log(`  F1 Score: ${metrics.f1_mean.toFixed(4)}`);
		console.log(`  BLEU-1: ${metrics.bleu1_mean.toFixed(4)}`);
		console.log(`  BLEU-4: ${metrics.bleu4_mean.toFixed(4)}`);
	}

	console.log(`\n${"=".repeat(80)}`);
}

async function main() {
	const startedAt = new Date().toISOString();
	const args = parseCliArgs();
	const baseUrl = args.port ? `http://127.0.0.1:${args.port}` : getOpencontextBaseUrl();
	const benchmarkDir = join(import.meta.dirname, "..");
	const manifestPath = getManifestPath(args.output, benchmarkDir, startedAt);
	let filteredSamples: Awaited<ReturnType<typeof loadLoCoMoDatasetFromJson>> = [];
	const parameterErrors: string[] = [];
	if (!Object.values(RetrievalMode).includes(args.mode)) {
		parameterErrors.push(
			`--mode must be one of: ${Object.values(RetrievalMode).join(", ")} (received: ${args.mode})`,
		);
	}
	if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535)) {
		parameterErrors.push("--port must be an integer between 1 and 65535");
	}

	await runPreflight({
		datasetPath: args.dataset,
		writablePaths: [
			manifestPath,
			join(benchmarkDir, "checkpoints", "locomo", ".preflight"),
			...(args.output ? [args.output] : []),
		],
		parameterErrors,
		validateDataset: async () => {
			const samples = await loadLoCoMoDatasetFromJson(args.dataset);
			filteredSamples =
				args.samples && args.samples.length > 0
					? samples.filter((sample) => args.samples?.includes(sample.sample_id))
					: samples;
			if (filteredSamples.length === 0) {
				throw new Error("no samples remain after applying --samples");
			}
		},
		checkDaemon: () => checkOpencontextHealth(baseUrl),
	});
	console.log(`🔌 OpenContext memory daemon: ${baseUrl}`);
	console.log(`\n📁 Loaded dataset from: ${args.dataset}`);
	if (args.samples && args.samples.length > 0) {
		console.log(`🔍 Filtered to ${filteredSamples.length} samples by ID`);
	}

	// Apply quick mode (first 5 questions only)
	if (args.quick) {
		console.log("⚡ Quick mode: limiting to first 5 questions per sample");
	}

	console.log(`📊 Loaded ${filteredSamples.length} LoCoMo samples for evaluation`);
	console.log(`🔧 Retrieval mode: ${args.mode}\n`);

	// Run evaluation
	const resultsBySample: EvaluationResult[] = [];
	const allPredictionsByCategory: Record<string, Prediction[]> = {};

	for (const sample of filteredSamples) {
		const evaluator = new LoCoMoEvaluator(args.mode, baseUrl, args.quick ? 5 : undefined, args.resume);

		try {
			// Ingest sample into the memory store
			await evaluator.loadSample(sample);

			// Evaluate QA
			const result = await evaluator.evaluateQA(sample);
			resultsBySample.push(result);

			// Organize predictions by category
			for (const pred of result.predictions) {
				const category = pred.category;
				if (!allPredictionsByCategory[category]) {
					allPredictionsByCategory[category] = [];
				}
				allPredictionsByCategory[category].push(pred);
			}

			console.log(
				`Sample ${sample.sample_id}: ${result.correct_answers}/${result.total_questions} correct (${(result.accuracy * 100).toFixed(2)}%)`,
			);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`Error evaluating sample ${sample.sample_id}: ${errorMessage}`);

			resultsBySample.push({
				sample_id: sample.sample_id,
				retrieval_mode: args.mode,
				total_questions: sample.qa_pairs.length,
				correct_answers: 0,
				accuracy: 0,
				token_usage: unavailableTokenUsage(),
				predictions: [],
				error: errorMessage,
			});
		}
	}

	// Aggregate results
	const totalQuestions = resultsBySample.reduce((sum, r) => sum + (r.total_questions || 0), 0);
	const totalCorrect = resultsBySample.reduce((sum, r) => sum + (r.correct_answers || 0), 0);
	const overallAccuracy = totalQuestions > 0 ? totalCorrect / totalQuestions : 0;

	const runTokenUsage = sumTokenUsage(resultsBySample.map((result) => result.token_usage));

	// Print summary
	await printEvaluationSummary(allPredictionsByCategory);

	// Prepare output
	const finishedAt = new Date().toISOString();
	const runManifest = await writeRunManifest(manifestPath, {
		benchmark: "locomo",
		datasetPath: args.dataset,
		answerer_model: getAnswererModelIdentity(),
		judge_model: JUDGE_MODEL,
		retrieval: { strategy: args.mode, top_k: RETRIEVAL_LIMIT },
		resume: args.resume,
		started_at: startedAt,
		finished_at: finishedAt,
		token_usage: runTokenUsage,
		parameters: { samples: args.samples ?? null, quick: args.quick ?? false },
	});
	const output = {
		retrieval_mode: args.mode,
		num_samples: resultsBySample.length,
		total_questions: totalQuestions,
		total_correct: totalCorrect,
		overall_accuracy: overallAccuracy,
		token_usage: runTokenUsage,
		total_tokens: runTokenUsage.total_tokens,
		run_manifest: runManifest,
		results_by_sample: resultsBySample.map((r) => ({
			sample_id: r.sample_id,
			accuracy: r.accuracy,
			correct: r.correct_answers,
			total: r.total_questions,
			token_usage: r.token_usage,
			error: r.error,
		})),
		results_by_category: allPredictionsByCategory,
	};

	// Save output if requested
	if (args.output) {
		await mkdir(dirname(resolve(args.output)), { recursive: true });
		await writeFile(args.output, JSON.stringify(output, null, 2), "utf-8");
		console.log(`\n💾 Results saved to: ${args.output}`);
	}
	console.log(`🧾 Run manifest saved to: ${manifestPath}`);

	return output;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
