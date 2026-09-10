/**
 * Evaluation metrics for LoCoMo benchmark.
 *
 * Includes LLM judge, BLEU, F1 score, and other metrics.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

import { tokenUsage, type TokenUsage, unavailableTokenUsage } from "../../run-support";

const openrouter = createOpenAICompatible({
	baseURL: "https://openrouter.ai/api/v1",
	apiKey: process.env.OPENROUTER_API_KEY,
	name: "openrouter",
});
import { LLM_JUDGE_PROMPT } from "./prompts";
import { sha256Text } from "./diagnostics";

const configuredModelRequestTimeoutMs = Number.parseInt(
	process.env.LOCOMO_MODEL_REQUEST_TIMEOUT_MS ?? "90000",
	10,
);
const MODEL_REQUEST_TIMEOUT_MS =
	Number.isInteger(configuredModelRequestTimeoutMs) && configuredModelRequestTimeoutMs >= 10_000
		? configuredModelRequestTimeoutMs
		: 90_000;
const JUDGE_SYSTEM_PROMPT =
	"You are an impartial judge evaluating answers to questions. Always respond with valid JSON.";

/**
 * Calculate F1 score between prediction and ground truth.
 */
export function calculateF1Score(prediction: string, groundTruth: string): number {
	if (!prediction || !groundTruth) {
		return 0.0;
	}

	// Tokenize
	const predTokens = new Set(prediction.toLowerCase().split(/\s+/));
	const gtTokens = new Set(groundTruth.toLowerCase().split(/\s+/));

	if (predTokens.size === 0 || gtTokens.size === 0) {
		return 0.0;
	}

	// Calculate precision, recall, F1
	const commonTokens = new Set([...predTokens].filter((x) => gtTokens.has(x)));
	const precision = commonTokens.size / predTokens.size;
	const recall = commonTokens.size / gtTokens.size;

	if (precision + recall === 0) {
		return 0.0;
	}

	const f1 = (2 * precision * recall) / (precision + recall);
	return f1;
}

/**
 * Calculate BLEU scores between prediction and ground truth.
 * Uses a pure JavaScript implementation with n-gram precision.
 */
export function calculateBLEUScores(
	prediction: string,
	groundTruth: string,
): { bleu1: number; bleu2: number; bleu3: number; bleu4: number } {
	if (!prediction || !groundTruth) {
		return { bleu1: 0.0, bleu2: 0.0, bleu3: 0.0, bleu4: 0.0 };
	}

	// Tokenize by whitespace
	const predTokens = prediction
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 0);
	const gtTokens = groundTruth
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 0);

	if (predTokens.length === 0 || gtTokens.length === 0) {
		return { bleu1: 0.0, bleu2: 0.0, bleu3: 0.0, bleu4: 0.0 };
	}

	// Helper to get n-grams
	const getNgrams = (tokens: string[], n: number): Set<string> => {
		const ngrams = new Set<string>();
		for (let i = 0; i <= tokens.length - n; i++) {
			ngrams.add(tokens.slice(i, i + n).join(" "));
		}
		return ngrams;
	};

	// Calculate n-gram precisions
	const getPrecision = (predTokens: string[], gtTokens: string[], n: number): number => {
		if (predTokens.length < n) return 0;

		const predNgrams = getNgrams(predTokens, n);
		const gtNgrams = getNgrams(gtTokens, n);

		if (predNgrams.size === 0) return 0;

		let matches = 0;
		for (const ngram of predNgrams) {
			if (gtNgrams.has(ngram)) {
				matches++;
			}
		}

		return matches / predNgrams.size;
	};

	const bleu1 = getPrecision(predTokens, gtTokens, 1);
	const bleu2 = getPrecision(predTokens, gtTokens, 2);
	const bleu3 = getPrecision(predTokens, gtTokens, 3);
	const bleu4 = getPrecision(predTokens, gtTokens, 4);

	// Apply brevity penalty (simplified)
	const brevityPenalty = Math.min(1.0, Math.exp(1 - gtTokens.length / Math.max(predTokens.length, 1)));

	return {
		bleu1: bleu1 * brevityPenalty,
		bleu2: bleu2 * brevityPenalty,
		bleu3: bleu3 * brevityPenalty,
		bleu4: bleu4 * brevityPenalty,
	};
}

/**
 * Calculate all metrics between prediction and ground truth.
 */
export function calculateMetrics(
	prediction: string,
	groundTruth: string,
): {
	f1: number;
	bleu1: number;
	bleu2: number;
	bleu3: number;
	bleu4: number;
} {
	const f1 = calculateF1Score(prediction, groundTruth);
	const bleuScores = calculateBLEUScores(prediction, groundTruth);

	return {
		f1,
		...bleuScores,
	};
}

interface LLMJudgeResult {
	label?: string;
	score?: number;
	reasoning?: string;
}

export function getJudgeModel(): string {
	const model = process.env.OPENROUTER_JUDGE_MODEL?.trim();
	if (!model) throw new Error("Judge model missing: set OPENROUTER_JUDGE_MODEL");
	return model;
}

export function getJudgeModelIdentity(): string {
	return `openrouter:${getJudgeModel()}`;
}

export interface LLMJudgeEvaluation {
	score: number;
	token_usage: TokenUsage;
	status: "completed" | "execution_error";
	attempt: number;
	latency_ms: number;
	prompt_version: string;
	prompt_sha256: string;
	prompt_characters: number;
	system_prompt: string;
	prompt: string;
	raw_response: string | null;
	parse_status: "parsed" | "failed";
	error?: string;
}

export function parseLLMJudgeResponse(text: string): number {
	const normalized = text.trim();
	if (!normalized) {
		throw new Error("Judge returned an empty response");
	}

	try {
		const result = JSON.parse(normalized) as LLMJudgeResult;
		const label = result.label?.trim().toUpperCase();
		if (label === "CORRECT") return 1;
		if (label === "WRONG") return 0;
		throw new Error("Judge JSON response is missing a valid CORRECT/WRONG label");
	} catch (error) {
		if (error instanceof SyntaxError) {
			const embeddedLabel = normalized.match(/"label"\s*:\s*"(CORRECT|WRONG)"/i)?.[1];
			if (embeddedLabel?.toUpperCase() === "CORRECT") return 1;
			if (embeddedLabel?.toUpperCase() === "WRONG") return 0;
			const upper = normalized.toUpperCase();
			const hasCorrect = /\bCORRECT\b/.test(upper);
			const hasWrong = /\bWRONG\b/.test(upper);
			if (hasCorrect && !hasWrong) return 1;
			if (hasWrong && !hasCorrect) return 0;
			throw new Error("Judge response could not be parsed as CORRECT or WRONG", { cause: error });
		}
		throw error;
	}
}

/**
 * Evaluate the generated answer against the gold answer using an LLM judge.
 * Includes retry logic for handling unstable API connections.
 *
 * Returns 1 for CORRECT and 0 for WRONG; throws if no attempt yields a valid label.
 */
export async function evaluateLLMJudge(
	question: string,
	goldAnswer: string,
	generatedAnswer: string,
	maxRetries = 5,
): Promise<LLMJudgeEvaluation> {
	const prompt = LLM_JUDGE_PROMPT.replace("{question}", question)
		.replace("{gold_answer}", goldAnswer)
		.replace("{generated_answer}", generatedAnswer);

	let lastError: Error | undefined;
	let lastRawResponse: string | null = null;
	let lastUsage = unavailableTokenUsage();
	const startedAt = performance.now();

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const { text, usage } = await generateText({
				model: openrouter(getJudgeModel()),
				system: JUDGE_SYSTEM_PROMPT,
				prompt,
				maxRetries: 0,
				abortSignal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
			});
			lastRawResponse = text;
			lastUsage = tokenUsage(usage.inputTokens, usage.outputTokens, usage.totalTokens);

			return {
				score: parseLLMJudgeResponse(text),
				token_usage: lastUsage,
				status: "completed",
				attempt,
				latency_ms: Math.round(performance.now() - startedAt),
				prompt_version: "locomo-judge-v1",
				prompt_sha256: sha256Text(prompt),
				prompt_characters: prompt.length,
				system_prompt: JUDGE_SYSTEM_PROMPT,
				prompt,
				raw_response: text,
				parse_status: "parsed",
			};
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt < maxRetries) {
				await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
			}
		}
	}
	return {
		score: 0,
		token_usage: lastUsage,
		status: "execution_error",
		attempt: maxRetries,
		latency_ms: Math.round(performance.now() - startedAt),
		prompt_version: "locomo-judge-v1",
		prompt_sha256: sha256Text(prompt),
		prompt_characters: prompt.length,
		system_prompt: JUDGE_SYSTEM_PROMPT,
		prompt,
		raw_response: lastRawResponse,
		parse_status: "failed",
		error: lastError?.message ?? "Judge failed without returning a result",
	};
}

/**
 * Calculate metrics for a category of results.
 */
export function calculateCategoryMetrics(
	results: Array<{
		llm_score?: number;
		f1_score?: number;
		bleu_score?: number;
		bleu4?: number;
	}>,
): {
	count: number;
	llm_judge_accuracy: number;
	llm_judge_correct: number;
	f1_mean: number;
	bleu1_mean: number;
	bleu4_mean: number;
} {
	if (results.length === 0) {
		return {
			count: 0,
			llm_judge_accuracy: 0.0,
			llm_judge_correct: 0,
			f1_mean: 0.0,
			bleu1_mean: 0.0,
			bleu4_mean: 0.0,
		};
	}

	// Extract metrics
	const llmScores = results.map((r) => r.llm_score ?? 0);
	const f1Scores = results.map((r) => r.f1_score ?? 0);
	const bleu1Scores = results.map((r) => r.bleu_score ?? 0);
	const bleu4Scores = results.map((r) => r.bleu4 ?? r.bleu_score ?? 0);

	const mean = (arr: number[]): number => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

	return {
		count: results.length,
		llm_judge_accuracy: mean(llmScores),
		llm_judge_correct: llmScores.filter((s) => s === 1).length,
		f1_mean: mean(f1Scores),
		bleu1_mean: mean(bleu1Scores),
		bleu4_mean: mean(bleu4Scores),
	};
}
