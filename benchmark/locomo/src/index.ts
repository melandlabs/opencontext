/** LoCoMo benchmark CLI. */

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { getManifestPath, runPreflight, sumTokenUsage, writeRunManifest } from "../../run-support";
import { loadLoCoMoDatasetFromJson } from "./dataset";
import { calculateDiagnosticSummary } from "./diagnostics";
import {
	LoCoMoEvaluator,
	RETRIEVAL_LIMIT,
	checkOpencontextHealth,
	getLoCoMoCheckpointDir,
	getOpencontextBaseUrl,
} from "./evaluator";
import { calculateCategoryMetrics, getJudgeModelIdentity } from "./metrics";
import { getAnswererModelIdentity } from "./opencontext-client";
import { getCategoryName } from "./scorer";
import {
	LOCOMO_TRACE_SCHEMA_VERSION,
	type EvaluationResult,
	type LoCoMoSessionTrace,
	type Prediction,
	RetrievalMode,
} from "./types";

interface CliArgs {
	dataset: string;
	mode: RetrievalMode;
	samples?: string[];
	quick?: boolean;
	output?: string;
	port?: number;
	resume: boolean;
	preflightOnly: boolean;
}

function parseCliArgs(): CliArgs {
	const args = process.argv.slice(2);
	const values: Record<string, string | boolean | number | undefined> = {
		mode: RetrievalMode.DIALOG,
		quick: false,
		resume: true,
		preflightOnly: false,
	};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--dataset" || arg === "-d") values.dataset = args[++index];
		else if (arg === "--mode" || arg === "-m") values.mode = args[++index];
		else if (arg === "--samples" || arg === "-s") values.samples = args[++index];
		else if (arg === "--quick" || arg === "-q") values.quick = true;
		else if (arg === "--output" || arg === "-o") values.output = args[++index];
		else if (arg === "--port" || arg === "-p") values.port = Number.parseInt(args[++index], 10);
		else if (arg === "--resume") values.resume = true;
		else if (arg === "--no-resume") values.resume = false;
		else if (arg === "--preflight-only") values.preflightOnly = true;
		else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}
	}
	if (!values.dataset) {
		printHelp();
		process.exit(1);
	}
	return {
		dataset: values.dataset as string,
		mode: values.mode as RetrievalMode,
		samples:
			typeof values.samples === "string"
				? values.samples.split(",").map((sample) => sample.trim())
				: undefined,
		quick: values.quick === true,
		output: values.output as string | undefined,
		port: values.port as number | undefined,
		resume: values.resume !== false,
		preflightOnly: values.preflightOnly === true,
	};
}

function printHelp(): void {
	process.stdout.write(`LoCoMo Benchmark CLI

Usage:
  pnpm benchmark -- --dataset <path.json> [options]

Required:
  -d, --dataset <path>        Path to LoCoMo JSON dataset

Filter:
  -m, --mode <mode>           Retrieval mode: dialog, observation,
                              session_summary (default: dialog)
  -s, --samples <csv>         Filter to specific sample IDs (csv)
  -q, --quick                 First 5 questions per sample

Mode:
      --resume / --no-resume  Reuse context-matched checkpoints (default: resume)
      --preflight-only         Validate readiness without ingest/model calls

API:
  -p, --port <n>              OpenContext daemon port (default: 7421,
                              env: OPENCONTEXT_PORT / OPENCONTEXT_URL)

Output:
  -o, --output <path>         Write results JSON to this path
`);
}

function diagnosticArtifactPath(outputPath: string, suffix: "trace" | "sessions"): string {
	const resolved = resolve(outputPath);
	return `${resolved.replace(/\.json$/i, "")}.${suffix}.jsonl`;
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const content = rows.map((row) => JSON.stringify(row)).join("\n");
	await writeFile(path, content.length > 0 ? `${content}\n` : "", "utf-8");
}

function withoutDiagnosticTrace(prediction: Prediction): Omit<Prediction, "trace"> {
	const { trace: _trace, ...result } = prediction;
	return result;
}

function printEvaluationSummary(resultsByCategory: Record<string, Prediction[]>): void {
	const predictions = Object.values(resultsByCategory).flat();
	const overall = calculateCategoryMetrics(predictions);
	process.stdout.write(
		`LoCoMo summary: questions=${overall.count}, correct=${overall.llm_judge_correct}, accuracy=${overall.llm_judge_accuracy.toFixed(4)}\n`,
	);
	for (const category of Object.keys(resultsByCategory).sort()) {
		const metrics = calculateCategoryMetrics(resultsByCategory[category]);
		process.stdout.write(
			`  ${category} (${getCategoryName(Number(category))}): ${metrics.llm_judge_correct}/${metrics.count} (${metrics.llm_judge_accuracy.toFixed(4)})\n`,
		);
	}
}

async function main() {
	const startedAt = new Date().toISOString();
	const args = parseCliArgs();
	const baseUrl = args.port ? `http://127.0.0.1:${args.port}` : getOpencontextBaseUrl();
	const benchmarkDir = join(import.meta.dirname, "..");
	const manifestPath = getManifestPath(args.output, benchmarkDir, startedAt);
	const tracePath = args.output ? diagnosticArtifactPath(args.output, "trace") : undefined;
	const sessionsPath = args.output ? diagnosticArtifactPath(args.output, "sessions") : undefined;
	let filteredSamples: Awaited<ReturnType<typeof loadLoCoMoDatasetFromJson>> = [];
	const parameterErrors: string[] = [];
	if (!Object.values(RetrievalMode).includes(args.mode)) {
		parameterErrors.push(`--mode must be one of: ${Object.values(RetrievalMode).join(", ")}`);
	}
	if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535)) {
		parameterErrors.push("--port must be an integer between 1 and 65535");
	}
	if (!process.env.OPENROUTER_JUDGE_MODEL?.trim()) {
		parameterErrors.push("judge model missing: set OPENROUTER_JUDGE_MODEL");
	}

	await runPreflight({
		datasetPath: args.dataset,
		writablePaths: [
			manifestPath,
			join(getLoCoMoCheckpointDir(), ".preflight"),
			...(args.output ? [args.output] : []),
			...(tracePath ? [tracePath] : []),
			...(sessionsPath ? [sessionsPath] : []),
		],
		parameterErrors,
		validateDataset: async () => {
			const samples = await loadLoCoMoDatasetFromJson(args.dataset);
			filteredSamples =
				args.samples && args.samples.length > 0
					? samples.filter((sample) => args.samples?.includes(sample.sample_id))
					: samples;
			if (filteredSamples.length === 0) throw new Error("no samples remain after applying --samples");
		},
		checkDaemon: () => checkOpencontextHealth(baseUrl),
	});

	if (args.preflightOnly) {
		const questionCount = filteredSamples.reduce(
			(sum, sample) => sum + (args.quick ? Math.min(5, sample.qa_pairs.length) : sample.qa_pairs.length),
			0,
		);
		process.stdout.write(
			`LoCoMo preflight passed: samples=${filteredSamples.length}, questions=${questionCount}, mode=${args.mode}, daemon=${baseUrl}, answerer=${getAnswererModelIdentity()}, judge=${getJudgeModelIdentity()}, top_k=${RETRIEVAL_LIMIT}\n`,
		);
		return;
	}

	const resultsBySample: EvaluationResult[] = [];
	const resultsByCategory: Record<string, Prediction[]> = {};
	const sessionTraces: LoCoMoSessionTrace[] = [];
	for (const sample of filteredSamples) {
		const evaluator = new LoCoMoEvaluator(args.mode, baseUrl, args.quick ? 5 : undefined, args.resume);
		let result: EvaluationResult;
		try {
			const reused = await evaluator.reuseCompletedSample(sample);
			if (!reused) await evaluator.loadSample(sample);
			result = await evaluator.evaluateQA(sample);
		} catch (error) {
			result = evaluator.createIngestErrorResult(sample, error);
		}
		resultsBySample.push(result);
		sessionTraces.push(...evaluator.getSessionTraces());
		for (const prediction of result.predictions) {
			if (!resultsByCategory[prediction.category]) resultsByCategory[prediction.category] = [];
			resultsByCategory[prediction.category].push(prediction);
		}
	}

	printEvaluationSummary(resultsByCategory);
	const predictions = resultsBySample.flatMap((result) => result.predictions);
	const completedPredictions = predictions.filter((prediction) => prediction.status === "completed");
	const totalQuestions = predictions.length;
	const totalCorrect = predictions.filter((prediction) => prediction.correct).length;
	const runTokenUsage = sumTokenUsage(predictions.map((prediction) => prediction.token_usage));
	const diagnosticSummary = calculateDiagnosticSummary(predictions);
	const finishedAt = new Date().toISOString();
	const runManifest = await writeRunManifest(manifestPath, {
		benchmark: "locomo",
		datasetPath: args.dataset,
		answerer_model: getAnswererModelIdentity(),
		judge_model: getJudgeModelIdentity(),
		retrieval: { strategy: "daemon-default", mode: args.mode, top_k: RETRIEVAL_LIMIT, diagnostics: true },
		resume: args.resume,
		started_at: startedAt,
		finished_at: finishedAt,
		token_usage: runTokenUsage,
		parameters: {
			samples: args.samples ?? null,
			quick: args.quick ?? false,
			trace_schema_version: LOCOMO_TRACE_SCHEMA_VERSION,
			trace_artifact: tracePath ?? null,
			sessions_artifact: sessionsPath ?? null,
		},
	});

	const output = {
		retrieval_mode: args.mode,
		num_samples: resultsBySample.length,
		total_questions: totalQuestions,
		total_correct: totalCorrect,
		overall_accuracy: totalQuestions > 0 ? totalCorrect / totalQuestions : 0,
		token_usage: runTokenUsage,
		summary: {
			all_records: calculateCategoryMetrics(predictions),
			completed_only: calculateCategoryMetrics(completedPredictions),
			execution_error_rate:
				predictions.length === 0
					? 0
					: (predictions.length - completedPredictions.length) / predictions.length,
		},
		diagnostics: diagnosticSummary,
		diagnostic_artifacts: {
			trace_schema_version: LOCOMO_TRACE_SCHEMA_VERSION,
			trace: tracePath ?? null,
			sessions: sessionsPath ?? null,
		},
		run_manifest: runManifest,
		results_by_sample: resultsBySample.map((result) => ({
			sample_id: result.sample_id,
			accuracy: result.accuracy,
			correct: result.correct_answers,
			total: result.total_questions,
			token_usage: result.token_usage,
			error: result.error,
		})),
		results_by_category: Object.fromEntries(
			Object.entries(resultsByCategory).map(([category, categoryPredictions]) => {
				const metrics = calculateCategoryMetrics(categoryPredictions);
				return [
					category,
					{
						name: getCategoryName(Number(category)),
						count: metrics.count,
						accuracy: metrics.llm_judge_accuracy,
						f1_mean: metrics.f1_mean,
						bleu1_mean: metrics.bleu1_mean,
						bleu4_mean: metrics.bleu4_mean,
						completed_only: calculateCategoryMetrics(
							categoryPredictions.filter((prediction) => prediction.status === "completed"),
						),
					},
				];
			}),
		),
		predictions,
	};

	if (args.output) {
		await mkdir(dirname(resolve(args.output)), { recursive: true });
		await writeFile(
			args.output,
			JSON.stringify({ ...output, predictions: output.predictions.map(withoutDiagnosticTrace) }, null, 2),
			"utf-8",
		);
		await writeJsonl(
			tracePath as string,
			predictions.map((prediction) => ({
				schema_version: prediction.trace_schema_version,
				sample_id: prediction.sample_id,
				question_index: prediction.question_index,
				sample_sha256: prediction.sample_sha256,
				question_sha256: prediction.question_sha256,
				retrieval_mode: prediction.retrieval_mode,
				question: prediction.question,
				ground_truth: prediction.ground_truth,
				evidence: prediction.evidence,
				status: prediction.status,
				attempt: prediction.attempt,
				execution_error: prediction.execution_error ?? null,
				failure_stage: prediction.failure_stage,
				answerer_model: prediction.answerer_model,
				judge_model: prediction.judge_model,
				response: prediction.response,
				llm_score: prediction.llm_score,
				correct: prediction.correct,
				token_usage: prediction.token_usage,
				trace: prediction.trace,
			})),
		);
		await writeJsonl(sessionsPath as string, sessionTraces);
		process.stdout.write(`Results saved to: ${args.output}\n`);
		process.stdout.write(`Question traces saved to: ${tracePath}\n`);
		process.stdout.write(`Session ingest traces saved to: ${sessionsPath}\n`);
	}
	process.stdout.write(`Run manifest saved to: ${manifestPath}\n`);
	return output;
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
