/**
 * Evaluation metrics for BEAM benchmark.
 *
 * Inherits F1 / BLEU / LLM judge from LongMemEval for parity with the
 * existing dashboards, then adds nugget-based scoring (BEAM-native).
 */

import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const openrouter = createOpenAICompatible({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  name: "openrouter",
});
import { BEAM_NUGGET_JUDGE_PROMPT } from "./prompts";
import type { BeamQuestionCategory } from "./types";

/**
 * Calculate F1 score between prediction and ground truth.
 */
export function calculateF1Score(
  prediction: string,
  groundTruth: string,
): number {
  if (!prediction || !groundTruth) {
    return 0.0;
  }

  // Tokenize
  const predTokens = new Set(prediction.toLowerCase().split(/\s+/));
  const gtTokens = new Set(String(groundTruth).toLowerCase().split(/\s+/));

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
 */
export function calculateBLEUScores(
  prediction: string,
  groundTruth: string,
): { bleu1: number; bleu2: number; bleu3: number; bleu4: number } {
  if (!prediction || !groundTruth) {
    return { bleu1: 0.0, bleu2: 0.0, bleu3: 0.0, bleu4: 0.0 };
  }

  const predTokens = prediction
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const gtTokens = String(groundTruth)
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (predTokens.length === 0 || gtTokens.length === 0) {
    return { bleu1: 0.0, bleu2: 0.0, bleu3: 0.0, bleu4: 0.0 };
  }

  const getNgrams = (tokens: string[], n: number): Set<string> => {
    const ngrams = new Set<string>();
    for (let i = 0; i <= tokens.length - n; i++) {
      ngrams.add(tokens.slice(i, i + n).join(" "));
    }
    return ngrams;
  };

  const getPrecision = (
    predTokens: string[],
    gtTokens: string[],
    n: number,
  ): number => {
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

  const brevityPenalty = Math.min(
    1.0,
    Math.exp(1 - gtTokens.length / Math.max(predTokens.length, 1)),
  );

  return {
    bleu1: bleu1 * brevityPenalty,
    bleu2: bleu2 * brevityPenalty,
    bleu3: bleu3 * brevityPenalty,
    bleu4: bleu4 * brevityPenalty,
  };
}

export interface NuggetJudgeResult {
  scores: number[];
  reasoning: string;
}

/**
 * Normalize a raw judge score into the BEAM rubric's {0.0, 0.5, 1.0} set.
 *
 * The judge is instructed to only output those three values, but LLMs
 * occasionally slip a 0.3 or 0.7 in. We snap to the nearest valid value
 * rather than rejecting the response — losing one judge's worth of data
 * is worse than a 0.5 rounding call.
 */
export function normalizeNuggetScore(raw: unknown): 0 | 0.5 | 1 {
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
  if (!Number.isFinite(n)) return 0;
  if (n >= 0.75) return 1;
  if (n >= 0.25) return 0.5;
  return 0;
}

/**
 * Detect a refusal/abstention in the generated answer. Used for the
 * abstention-category special-case in the rubric and for debugging.
 *
 * Heuristic list — not exhaustive. If we ever ship a hard eval on
 * abstention, replace this with a dedicated classifier.
 */
export function looksLikeAbstention(answer: string): boolean {
  if (!answer) return false;
  const lowered = answer.toLowerCase();
  return (
    /\bi (?:do not|don't|can't|cannot) (?:know|have|remember)\b/.test(
      lowered,
    ) ||
    /\bno (?:information|record|mention|evidence)\b/.test(lowered) ||
    /\bnot (?:available|provided|mentioned)\b/.test(lowered) ||
    /\bi'?d (?:rather )?(?:decline|refuse|not )?\b/.test(lowered) ||
    /\b(?:i'?ll|i will) (?:decline|refuse|pass)\b/.test(lowered)
  );
}

/**
 * Try to extract the first JSON object out of a free-form judge response.
 * LLMs occasionally wrap the JSON in prose ("Here is my judgment: {...}")
 * even when told not to.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Score one generated answer against the BEAM nugget atoms.
 *
 * Includes the same retry-with-exponential-backoff pattern as
 * `evaluateLLMJudge` (longmemeval). On total failure we fall back to
 * all-zeros so the run is never blocked — the warning log makes the
 * data point visible in summary.
 */
export async function evaluateNuggetJudge(
  question: string,
  category: BeamQuestionCategory,
  atoms: string[],
  generatedAnswer: string,
  maxRetries = 3,
): Promise<NuggetJudgeResult> {
  if (atoms.length === 0) {
    return { scores: [], reasoning: "no atoms" };
  }

  const prompt = BEAM_NUGGET_JUDGE_PROMPT.replace("{category}", category)
    .replace("{question}", question)
    .replace("{atoms}", atoms.map((a, i) => `${i + 1}. ${a}`).join("\n"))
    .replace("{answer}", generatedAnswer);

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { text } = await generateText({
        model: openrouter("qwen/qwen3.7-max"),
        system:
          "You are an impartial judge scoring answers to questions. Always respond with valid JSON.",
        prompt,
      });

      let parsed: Partial<NuggetJudgeResult> | null = null;

      try {
        parsed = JSON.parse(text) as Partial<NuggetJudgeResult>;
      } catch {
        const slice = extractFirstJsonObject(text);
        if (slice) {
          try {
            parsed = JSON.parse(slice) as Partial<NuggetJudgeResult>;
          } catch {
            parsed = null;
          }
        }
      }

      if (parsed && Array.isArray(parsed.scores)) {
        const scores = parsed.scores
          .slice(0, atoms.length)
          .map((s) => normalizeNuggetScore(s));

        // Pad if the judge under-reported.
        while (scores.length < atoms.length) scores.push(0);

        return {
          scores,
          reasoning:
            typeof parsed.reasoning === "string"
              ? parsed.reasoning
              : "(no reasoning)",
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.log(
        `[Judge] Attempt ${attempt}/${maxRetries} failed: ${lastError.message.substring(0, 80)}`,
      );
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  console.error(
    `[Judge] All ${maxRetries} attempts failed. Last error: ${lastError?.message}`,
  );
  return {
    scores: atoms.map(() => 0),
    reasoning: `judge failure: ${lastError?.message ?? "unknown"}`,
  };
}

/**
 * Aggregate nugget scores for one question into the headline metric.
 *
 * `nugget_pass` = mean >= 0.5, matching BEAM's "is this question
 * answered well enough" notion used in published leaderboards.
 */
export function summarizeNuggetScores(scores: number[]): {
  nugget_mean: number;
  nugget_pass: boolean;
} {
  if (scores.length === 0) {
    return { nugget_mean: 0, nugget_pass: false };
  }
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { nugget_mean: mean, nugget_pass: mean >= 0.5 };
}

/**
 * Roll up predictions into per-category nugget metrics.
 */
export interface NuggetCategoryMetrics {
  count: number;
  nugget_mean: number;
  nugget_pass_count: number;
  nugget_pass_rate: number;
  abstention_count: number;
}

export function calculateNuggetCategoryMetrics(
  predictions: Array<{
    nugget_mean?: number;
    nugget_pass?: boolean;
    category?: BeamQuestionCategory;
    abstained?: boolean;
  }>,
): NuggetCategoryMetrics {
  if (predictions.length === 0) {
    return {
      count: 0,
      nugget_mean: 0.0,
      nugget_pass_count: 0,
      nugget_pass_rate: 0.0,
      abstention_count: 0,
    };
  }

  const means = predictions.map((p) => p.nugget_mean ?? 0);
  const passes = predictions.filter((p) => p.nugget_pass === true).length;
  const abstentions = predictions.filter((p) => p.abstained === true).length;

  return {
    count: predictions.length,
    nugget_mean: means.reduce((a, b) => a + b, 0) / means.length,
    nugget_pass_count: passes,
    nugget_pass_rate: passes / predictions.length,
    abstention_count: abstentions,
  };
}

/**
 * Calculate F1 + BLEU for a prediction (LongMemEval parity, used when
 * a `gold_answer` is present).
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
