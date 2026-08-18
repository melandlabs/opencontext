/**
 * Types for BEAM (Benchmarking EffecTive Agent Memory) evaluation.
 *
 * BEAM is from Tavakoli et al., ICLR 2026 (arXiv:2510.27246). It defines
 * 10 question categories across 4 buckets (128K / 500K / 1M / 10M).
 */

export type BeamScale = "128k" | "500k" | "1m" | "10m";

export type BeamQuestionCategory =
  | "abstention"
  | "contradiction_resolution"
  | "event_ordering"
  | "information_extraction"
  | "instruction_following"
  | "knowledge_update"
  | "multi_session_reasoning"
  | "preference_following"
  | "summarization"
  | "temporal_reasoning";

export const BEAM_QUESTION_CATEGORIES: BeamQuestionCategory[] = [
  "abstention",
  "contradiction_resolution",
  "event_ordering",
  "information_extraction",
  "instruction_following",
  "knowledge_update",
  "multi_session_reasoning",
  "preference_following",
  "summarization",
  "temporal_reasoning",
];

export const BEAM_SCALES: BeamScale[] = ["128k", "500k", "1m", "10m"];

/**
 * A single turn in a BEAM conversation.
 * `speaker` is the role label used in BEAM (typically "user" / "assistant"
 * but can also be named personas).
 */
export interface BeamTurn {
  speaker: string;
  text: string;
  timestamp?: string;
}

/**
 * A BEAM probing question (with nugget atoms for grading).
 *
 * `atoms` are the smallest units of information the answer should contain.
 * The nugget judge scores each atom 0.0 / 0.5 / 1.0 — the per-question
 * nugget mean is what gets aggregated into category and overall metrics.
 */
export interface BeamProbingQuestion {
  question_id: string;
  category: BeamQuestionCategory;
  question: string;
  atoms: string[];
  /**
   * Optional gold answer for human inspection. The official BEAM scoring
   * is nugget-based (atoms), not against this string.
   */
  gold_answer?: string;
}

/**
 * A single BEAM conversation.
 *
 * BEAM stores the entire chat as a flat list of turns (avg 842 turns @ 1M,
 * avg 7,757 turns @ 10M), so there is no separate session_id list.
 */
export interface BeamConversation {
  entry_id: string;
  /**
   * Approximate total token count the conversation is designed around.
   * BEAM uses buckets (128K / 500K / 1M / 10M) of "tokens of context".
   */
  scale: BeamScale;
  chat: BeamTurn[];
  probing_questions: BeamProbingQuestion[];
}

/**
 * Top-level BEAM dataset file (one JSON file per scale).
 */
export interface BeamDatasetFile {
  scale: BeamScale;
  conversations: BeamConversation[];
}

/**
 * Evaluation result for a single conversation entry.
 */
export interface EvaluationResult {
  entry_id: string;
  scale: BeamScale;
  total_questions: number;
  correct_answers: number;
  /**
   * Mean nugget score across all questions (0.0–1.0).
   */
  nugget_mean: number;
  /**
   * Fraction of questions with nugget_mean >= 0.5.
   */
  nugget_pass_rate: number;
  token_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  predictions: Prediction[];
  error?: string;
}

/**
 * Prediction result for a single question.
 */
export interface Prediction {
  question_id: string;
  question: string;
  response: string;
  prediction: string;
  /**
   * Atoms that were sent to the judge. Stored so the results JSON is
   * self-describing and can be re-graded without re-loading the dataset.
   */
  atoms: string[];
  category: BeamQuestionCategory;
  scale: BeamScale;
  /**
   * Per-atom scores returned by the nugget judge.
   * Each entry is one of 0.0 | 0.5 | 1.0.
   */
  nugget_scores: number[];
  /**
   * Mean of `nugget_scores` — the per-question nugget score.
   */
  nugget_mean: number;
  /**
   * True iff `nugget_mean >= 0.5`. Used for the pass-rate metric.
   */
  nugget_pass: boolean;
  judge_reasoning: string;
  /**
   * True if the agent produced a refusal/abstention for abstention-category
   * questions (recorded separately for debugging).
   */
  abstained: boolean;
}
