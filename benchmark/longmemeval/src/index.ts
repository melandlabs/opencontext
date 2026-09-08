/**
 * LongMemEval Benchmark CLI
 *
 * Run via: pnpm benchmark:longmemeval -- --dataset dataset/longmemeval_s_cleaned.json --quick
 */

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getManifestPath, runPreflight, sumTokenUsage, writeRunManifest } from "../../run-support";
import { loadLongMemEvalDatasetFromJson } from "./dataset";
import { calculateDiagnosticSummary } from "./diagnostics";
import { LongMemEvalEvaluator, RETRIEVAL_LIMIT, getLongMemEvalCheckpointDir } from "./evaluator";
import { calculateCategoryMetrics, getJudgeModelIdentity } from "./metrics";
import {
	checkOpencontextHealth,
	getAnswererModelIdentity,
	getOpencontextBaseUrl,
} from "./opencontext-client";
import { QUESTION_TYPE_NAMES } from "./scorer";
import { LONGMEMEVAL_TRACE_SCHEMA_VERSION, type Prediction } from "./types";

interface CliArgs {
	dataset: string;
	samples?: string[];
	quick?: boolean;
	output?: string;
	port?: number;
	resume: boolean;
	preflightOnly: boolean;
}

function parseCliArgs(): CliArgs {
	const args = process.argv.slice(2);
	const values: Record<string, string | boolean | number | string[] | undefined> = {
		quick: false,
		resume: true,
		preflightOnly: false,
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
		} else if (arg === "--preflight-only") {
			values.preflightOnly = true;
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
		preflightOnly: values.preflightOnly === true,
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
      --preflight-only         Validate data, daemon, credentials, and paths;
                               do not ingest or call answerer/judge models

API:
  -p, --port <n>              OpenContext memory daemon port (default: 7421,
                              env: OPENCONTEXT_PORT / OPENCONTEXT_URL)

Output:
  -o, --output <path>         Write results JSON to this path
`);
}

function diagnosticArtifactPath(outputPath: string, suffix: "trace" | "sessions"): string {
	const resolved = resolve(outputPath);
	const base = resolved.replace(/\.json$/i, "");
	return `${base}.${suffix}.jsonl`;
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
	const startedAt = new Date().toISOString();
	const args = parseCliArgs();
	const baseUrl = args.port ? `http://127.0.0.1:${args.port}` : getOpencontextBaseUrl();
	const benchmarkDir = join(import.meta.dirname, "..");
	const manifestPath = getManifestPath(args.output, benchmarkDir, startedAt);
	const tracePath = args.output ? diagnosticArtifactPath(args.output, "trace") : undefined;
	const sessionsPath = args.output ? diagnosticArtifactPath(args.output, "sessions") : undefined;
	let filteredEntries: Awaited<ReturnType<typeof loadLongMemEvalDatasetFromJson>> = [];
	const parameterErrors: string[] = [];
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
			join(getLongMemEvalCheckpointDir(), ".preflight"),
			...(args.output ? [args.output] : []),
			...(tracePath ? [tracePath] : []),
			...(sessionsPath ? [sessionsPath] : []),
		],
		parameterErrors,
		validateDataset: async () => {
			const entries = await loadLongMemEvalDatasetFromJson(args.dataset);
			filteredEntries =
				args.samples && args.samples.length > 0
					? entries.filter((entry) => args.samples?.includes(entry.question_id))
					: entries;
			if (args.quick) filteredEntries = filteredEntries.slice(0, 5);
			if (filteredEntries.length === 0) {
				throw new Error("no entries remain after applying --samples/--quick");
			}
		},
		checkDaemon: () => checkOpencontextHealth(baseUrl),
	});
	if (args.preflightOnly) {
		process.stdout.write(
			`LongMemEval preflight passed: entries=${filteredEntries.length}, daemon=${baseUrl}, answerer=${getAnswererModelIdentity()}, judge=${getJudgeModelIdentity()}, top_k=${RETRIEVAL_LIMIT}\n`,
		);
		return;
	}

	// Run evaluation
	const allPredictionsByType: Record<string, Prediction[]> = {};
	let correct = 0;
	let total = 0;
	const evaluator = new LongMemEvalEvaluator(baseUrl, undefined, args.resume);

	for (const entry of filteredEntries) {
		try {
			// A completed, context-matched checkpoint has already passed daemon
			// ingestion. Rehydrate its raw-session mapping for evidence, but do not
			// replay hundreds of idempotent ingestion calls before resuming work.
			let pred = await evaluator.reuseCompletedCheckpoint(entry);
			if (pred === null) {
				await evaluator.loadEntry(entry);
				pred = await evaluator.evaluateQuestion(entry);
			}

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
			const failedPred = evaluator.createExecutionErrorPrediction(entry, error, "ingest");

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
	const predictions = Object.values(allPredictionsByType).flat();
	const completedPredictions = predictions.filter((prediction) => prediction.status === "completed");
	const runTokenUsage = sumTokenUsage(predictions.map((prediction) => prediction.token_usage));
	const diagnosticSummary = calculateDiagnosticSummary(predictions);
	const finishedAt = new Date().toISOString();
	const runManifest = await writeRunManifest(manifestPath, {
		benchmark: "longmemeval",
		datasetPath: args.dataset,
		answerer_model: getAnswererModelIdentity(),
		judge_model: getJudgeModelIdentity(),
		retrieval: { strategy: "daemon-default", top_k: RETRIEVAL_LIMIT, diagnostics: true },
		resume: args.resume,
		started_at: startedAt,
		finished_at: finishedAt,
		token_usage: runTokenUsage,
		parameters: {
			samples: args.samples ?? null,
			quick: args.quick ?? false,
			trace_schema_version: LONGMEMEVAL_TRACE_SCHEMA_VERSION,
			trace_artifact: tracePath ?? null,
			sessions_artifact: sessionsPath ?? null,
		},
	});

	const output = {
		num_entries: filteredEntries.length,
		total_questions: total,
		total_correct: correct,
		overall_accuracy: overallAccuracy,
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
			trace_schema_version: LONGMEMEVAL_TRACE_SCHEMA_VERSION,
			trace: tracePath ?? null,
			sessions: sessionsPath ?? null,
		},
		run_manifest: runManifest,
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
						completed_only: calculateCategoryMetrics(
							preds.filter((prediction) => prediction.status === "completed"),
						),
						predictions: preds.map((p) => ({
							question_id: p.question_id,
							status: p.status,
							correct: p.correct,
							llm_score: p.llm_score,
							f1_score: p.f1_score,
						})),
					},
				];
			}),
		),
		predictions,
	};

	// Save output if requested
	if (args.output) {
		await mkdir(dirname(resolve(args.output)), { recursive: true });
		await writeFile(
			args.output,
			JSON.stringify(
				{
					...output,
					predictions: output.predictions.map(withoutDiagnosticTrace),
				},
				null,
				2,
			),
			"utf-8",
		);
		await writeJsonl(
			tracePath as string,
			predictions.map((prediction) => ({
				schema_version: prediction.trace_schema_version,
				question_id: prediction.question_id,
				entry_sha256: prediction.entry_sha256,
				question_sha256: prediction.question_sha256,
				question: prediction.question,
				question_date: prediction.question_date,
				ground_truth: prediction.ground_truth,
				evidence_session_ids: prediction.evidence_session_ids,
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
		await writeJsonl(sessionsPath as string, evaluator.getSessionTraces());
		process.stdout.write(`Question traces saved to: ${tracePath}\n`);
		process.stdout.write(`Session ingest traces saved to: ${sessionsPath}\n`);
	}
	// biome-ignore lint/suspicious/noConsole: benchmark CLI reports the manifest artifact path
	console.log(`Run manifest saved to: ${manifestPath}`);

	return output;
}

main().catch((error) => {
	// biome-ignore lint/suspicious/noConsole: fatal CLI errors must be visible to the caller
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
