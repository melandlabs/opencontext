/**
 * Types for BEAM (Benchmarking EffecTive Agent Memory) evaluation.
 *
 * BEAM is from Tavakoli et al., ICLR 2026 (arXiv:2510.27246). It defines
 * 10 question categories across 4 buckets (128K / 500K / 1M / 10M).
 */

import type { TokenUsage } from "../../run-support";

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
	/** Stable id from the upstream BEAM chat row, used for provenance only. */
	source_id?: string;
	/** Optional upstream display/index label (for example `1,1`). */
	source_index?: string;
}

export interface BeamQuestionSource {
	/** Upstream chat turn ids that contain the evidence for this question. */
	source_chat_ids: string[];
	conversation_references: string[];
	plan_references: string[];
	why_unanswerable?: string;
}

export interface BeamDatasetSource {
	repository: string;
	config: string;
	split: string;
	revision: string;
	converter_schema_version: string;
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
	/** Upstream provenance. Empty ids mean the source did not provide an exact mapping. */
	source: BeamQuestionSource;
}

export const BEAM_TRACE_SCHEMA_VERSION = "1.1";

export type BeamExecutionStatus = "completed" | "execution_error";

export type BeamFailureStage =
	| "none"
	| "dataset_reference_missing"
	| "dataset_reference_partial"
	| "ingest_or_index_error"
	| "retrieval_error"
	| "retrieval_miss"
	| "retrieval_partial"
	| "answerer_error"
	| "context_present_answer_failed"
	| "judge_error"
	| "provider_error";

export interface BeamChunkTrace {
	schema_version: string;
	entry_id: string;
	scale: BeamScale;
	message_id: string;
	chunk_index: number;
	ingest_batch_index: number;
	turn_start: number;
	turn_end: number;
	source_turn_ids: string[];
	content_sha256: string;
	content_characters: number;
	first_timestamp: string | null;
	last_timestamp: string | null;
	ingest_status: "pending" | "not_attempted" | "completed" | "partial" | "execution_error";
	ingest_latency_ms: number | null;
	ingest_warnings: unknown[];
	error?: string;
}

export interface BeamRetrievalHitTrace {
	rank: number;
	id: string;
	similarity: number;
	signals: Record<string, unknown> | null;
	metadata: Record<string, unknown>;
	content_sha256: string;
	content_characters: number;
	content_excerpt: string;
	content: string;
	source_turn_ids: string[];
	matched_source_turn_ids: string[];
	relevant: boolean | null;
}

export interface BeamRetrievalTrace {
	status: "completed" | "execution_error";
	query: string;
	user_id: string;
	top_k: number;
	strategy: "daemon-default";
	latency_ms: number;
	response_query: string;
	response_sources: string[];
	response_count: number;
	response_warnings: unknown[];
	response_reasoning: unknown | null;
	hits: BeamRetrievalHitTrace[];
	retrieval_applicable: boolean;
	required_source_turn_ids: string[];
	available_source_turn_ids: string[];
	missing_source_turn_ids: string[];
	retrieved_source_turn_ids: string[];
	missed_source_turn_ids: string[];
	dataset_source_coverage: number | null;
	source_recall_at_k: number | null;
	retrievable_source_recall_at_k: number | null;
	all_required_sources_retrieved: boolean | null;
	hit_at_k: number | null;
	first_relevant_rank: number | null;
	mrr: number | null;
	precision_at_k: number | null;
	relevant_hit_precision: number | null;
	error?: string;
}

export interface BeamModelCallTrace {
	model: string;
	status: "completed" | "skipped" | "execution_error";
	attempt: number;
	latency_ms: number;
	prompt_version: string;
	prompt_sha256: string | null;
	prompt_characters: number;
	system_prompt: string | null;
	prompt: string | null;
	token_usage: TokenUsage;
	error?: string;
}

export interface BeamAnswerTrace extends BeamModelCallTrace {
	included_hit_ids: string[];
	cited_hit_ids: string[];
	cited_relevant_hit_ids: string[];
	attribution_status: "supported" | "unsupported" | "uncited" | "not_applicable";
}

export interface BeamJudgeTrace extends BeamModelCallTrace {
	raw_response: string | null;
	parse_status: "parsed" | "skipped" | "failed";
}

export interface BeamQuestionTrace {
	retrieval: BeamRetrievalTrace | null;
	answerer: BeamAnswerTrace | null;
	judge: BeamJudgeTrace | null;
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
	source?: BeamDatasetSource;
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
	token_usage: TokenUsage;
	predictions: Prediction[];
	error?: string;
}

/**
 * Prediction result for a single question.
 */
export interface Prediction {
	trace_schema_version: string;
	entry_id: string;
	conversation_sha256: string;
	question_sha256: string;
	status: BeamExecutionStatus;
	attempt: number;
	execution_error?: { stage: string; message: string };
	token_usage: TokenUsage;
	answerer_model: string;
	judge_model: string;
	question_id: string;
	question: string;
	gold_answer: string | null;
	source: BeamQuestionSource;
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
	trace: BeamQuestionTrace;
	failure_stage: BeamFailureStage;
	/**
	 * True if the agent produced a refusal/abstention for abstention-category
	 * questions (recorded separately for debugging).
	 */
	abstained: boolean;
}
