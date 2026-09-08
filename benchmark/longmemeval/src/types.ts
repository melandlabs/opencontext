/**
 * Types for LongMemEval benchmark evaluation.
 */

import type { TokenUsage } from "../../run-support";

/**
 * A single turn in a conversation session.
 */
export interface ConversationTurn {
	role: "user" | "assistant";
	content: string;
}

/**
 * A question entry from the LongMemEval dataset.
 */
export interface LongMemEvalEntry {
	question_id: string;
	question_type: string;
	question: string;
	question_date: string;
	answer: string;
	answer_session_ids: string[];
	haystack_dates: string[];
	haystack_session_ids: string[];
	haystack_sessions: ConversationTurn[][];
}

export const LONGMEMEVAL_TRACE_SCHEMA_VERSION = "1.0";

export type LongMemEvalExecutionStatus = "completed" | "execution_error";

export type LongMemEvalFailureStage =
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

export interface LongMemEvalSessionTrace {
	schema_version: string;
	question_id: string;
	message_id: string;
	session_id: string;
	session_index: number;
	ingest_batch_index: number;
	session_date: string | null;
	turn_count: number;
	content_sha256: string;
	content_characters: number;
	ingest_status: "pending" | "not_attempted" | "completed" | "partial" | "execution_error";
	ingest_latency_ms: number | null;
	ingest_warnings: unknown[];
	error?: string;
}

export interface LongMemEvalRetrievalHitTrace {
	rank: number;
	id: string;
	similarity: number;
	signals: Record<string, unknown> | null;
	metadata: Record<string, unknown>;
	content_sha256: string;
	content_characters: number;
	content_excerpt: string;
	/** Full text is retained for final Top-K hits; candidate channels retain hash/excerpt only. */
	content?: string;
	session_ids: string[];
	matched_answer_session_ids: string[];
	relevant: boolean | null;
}

export interface LongMemEvalRetrievalTrace {
	status: "completed" | "execution_error";
	query: string;
	user_id: string;
	top_k: number;
	candidate_k: number | null;
	strategy: "daemon-default";
	merge_strategy: "rrf" | "similarity" | null;
	threshold: null;
	backend: string | null;
	semantic_degraded_reason: string | null;
	candidate_counts: {
		semantic: number;
		lexical: number;
		hybrid: number;
		entity: number;
		fused: number;
		final: number;
	} | null;
	latency_ms: number;
	response_query: string;
	response_sources: string[];
	response_count: number;
	response_warnings: unknown[];
	response_reasoning: unknown | null;
	premerge_diagnostics_available: boolean;
	candidate_channels: {
		semantic: LongMemEvalRetrievalHitTrace[];
		lexical: LongMemEvalRetrievalHitTrace[];
		hybrid: LongMemEvalRetrievalHitTrace[];
		entity: LongMemEvalRetrievalHitTrace[];
	};
	fused_before_rerank: LongMemEvalRetrievalHitTrace[];
	reranker: {
		enabled: boolean;
		provider: string | null;
		model: string | null;
		input_count: number;
		output_count: number;
		latency_ms: number;
		order_changed: boolean;
	} | null;
	semantic_answer_session_recall_at_candidate_k: number | null;
	lexical_answer_session_recall_at_candidate_k: number | null;
	hybrid_answer_session_recall_at_candidate_k: number | null;
	hits: LongMemEvalRetrievalHitTrace[];
	retrieval_applicable: boolean;
	required_answer_session_ids: string[];
	available_answer_session_ids: string[];
	missing_answer_session_ids: string[];
	retrieved_answer_session_ids: string[];
	missed_answer_session_ids: string[];
	dataset_source_coverage: number | null;
	answer_session_recall_at_k: number | null;
	retrievable_answer_session_recall_at_k: number | null;
	all_answer_sessions_retrieved: boolean | null;
	hit_at_k: number | null;
	first_relevant_rank: number | null;
	mrr: number | null;
	precision_at_k: number | null;
	relevant_hit_precision: number | null;
	error?: string;
}

export interface LongMemEvalModelCallTrace {
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

export interface LongMemEvalAnswerTrace extends LongMemEvalModelCallTrace {
	included_hit_ids: string[];
	included_context_characters: number;
}

export interface LongMemEvalJudgeTrace extends LongMemEvalModelCallTrace {
	raw_response: string | null;
	parse_status: "parsed" | "skipped" | "failed";
}

export interface LongMemEvalQuestionTrace {
	retrieval: LongMemEvalRetrievalTrace | null;
	answerer: LongMemEvalAnswerTrace | null;
	judge: LongMemEvalJudgeTrace | null;
}

/**
 * Evaluation result for a single sample.
 */
export interface EvaluationResult {
	question_id: string;
	question_type: string;
	total_questions: number;
	correct_answers: number;
	accuracy: number;
	token_usage: TokenUsage;
	predictions: Prediction[];
	error?: string;
}

/**
 * Prediction result for a single question.
 */
export interface Prediction {
	trace_schema_version: string;
	entry_sha256: string;
	question_sha256: string;
	status: LongMemEvalExecutionStatus;
	attempt: number;
	answerer_model: string;
	judge_model: string;
	execution_error?: { stage: string; message: string };
	token_usage: TokenUsage;
	question_id: string;
	question: string;
	question_date: string;
	answer: string | number;
	response: string;
	prediction: string;
	ground_truth: string;
	question_type: string;
	llm_score: number;
	correct: boolean;
	f1_score: number;
	bleu_score: number;
	bleu1: number;
	bleu2: number;
	bleu3: number;
	bleu4: number;
	evidence_session_ids: string[];
	trace: LongMemEvalQuestionTrace;
	failure_stage: LongMemEvalFailureStage;
}
