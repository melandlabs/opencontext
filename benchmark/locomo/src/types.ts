/** Types for LoCoMo benchmark evaluation. */

import type { TokenUsage } from "../../run-support";

export enum RetrievalMode {
	DIALOG = "dialog",
	OBSERVATION = "observation",
	SESSION_SUMMARY = "session_summary",
}

export interface QAPair {
	question: string;
	answer: string;
	category: number;
	evidence: string[];
}

export interface LoCoMoSample {
	sample_id: string;
	conversation: Record<string, unknown>;
	observation: Record<string, unknown>;
	session_summary: Record<string, unknown>;
	event_summary: Record<string, unknown>;
	qa_pairs: QAPair[];
}

export const LOCOMO_TRACE_SCHEMA_VERSION = "1.0";

export type LoCoMoExecutionStatus = "completed" | "execution_error";

export type LoCoMoFailureStage =
	| "none"
	| "gold_evidence_unavailable"
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

export interface LoCoMoSessionTrace {
	schema_version: string;
	sample_id: string;
	retrieval_mode: RetrievalMode;
	message_id: string;
	session_id: string;
	session_index: number;
	ingest_batch_index: number;
	session_date: string | null;
	evidence_ids: string[];
	content_sha256: string;
	content_characters: number;
	ingest_status: "pending" | "not_attempted" | "completed" | "partial" | "execution_error";
	ingest_latency_ms: number | null;
	ingest_warnings: unknown[];
	error?: string;
}

export interface LoCoMoRetrievalHitTrace {
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
	evidence_ids: string[];
	matched_evidence_ids: string[];
	relevant: boolean | null;
}

export interface LoCoMoRetrievalTrace {
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
		semantic: LoCoMoRetrievalHitTrace[];
		lexical: LoCoMoRetrievalHitTrace[];
		hybrid: LoCoMoRetrievalHitTrace[];
		entity: LoCoMoRetrievalHitTrace[];
	};
	fused_before_rerank: LoCoMoRetrievalHitTrace[];
	reranker: {
		enabled: boolean;
		provider: string | null;
		model: string | null;
		input_count: number;
		output_count: number;
		latency_ms: number;
		order_changed: boolean;
	} | null;
	hits: LoCoMoRetrievalHitTrace[];
	retrieval_applicable: boolean;
	evidence_granularity: "dialog_turn" | "unavailable";
	required_evidence_ids: string[];
	available_evidence_ids: string[];
	missing_evidence_ids: string[];
	retrieved_evidence_ids: string[];
	missed_evidence_ids: string[];
	dataset_evidence_coverage: number | null;
	evidence_recall_at_k: number | null;
	retrievable_evidence_recall_at_k: number | null;
	all_evidence_retrieved: boolean | null;
	hit_at_k: number | null;
	first_relevant_rank: number | null;
	mrr: number | null;
	precision_at_k: number | null;
	relevant_hit_precision: number | null;
	semantic_evidence_recall_at_candidate_k: number | null;
	lexical_evidence_recall_at_candidate_k: number | null;
	hybrid_evidence_recall_at_candidate_k: number | null;
	error?: string;
}

export interface LoCoMoModelCallTrace {
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

export interface LoCoMoAnswerTrace extends LoCoMoModelCallTrace {
	included_hit_ids: string[];
	included_context_characters: number;
}

export interface LoCoMoJudgeTrace extends LoCoMoModelCallTrace {
	raw_response: string | null;
	parse_status: "parsed" | "skipped" | "failed";
}

export interface LoCoMoQuestionTrace {
	retrieval: LoCoMoRetrievalTrace | null;
	answerer: LoCoMoAnswerTrace | null;
	judge: LoCoMoJudgeTrace | null;
}

export interface EvaluationResult {
	sample_id: string;
	retrieval_mode: RetrievalMode;
	total_questions: number;
	correct_answers: number;
	accuracy: number;
	token_usage: TokenUsage;
	predictions: Prediction[];
	error?: string;
}

export interface Prediction {
	trace_schema_version: string;
	sample_sha256: string;
	question_sha256: string;
	status: LoCoMoExecutionStatus;
	attempt: number;
	answerer_model: string;
	judge_model: string;
	execution_error?: { stage: string; message: string };
	token_usage: TokenUsage;
	sample_id: string;
	question_index: number;
	retrieval_mode: RetrievalMode;
	question: string;
	answer: string;
	response: string;
	prediction: string;
	ground_truth: string;
	category: string;
	llm_score: number;
	correct: boolean;
	f1_score: number;
	bleu_score: number;
	bleu1: number;
	bleu2: number;
	bleu3: number;
	bleu4: number;
	evidence: string[];
	trace: LoCoMoQuestionTrace;
	failure_stage: LoCoMoFailureStage;
}

export interface Chunk {
	id: string;
	content: string;
	embedding: number[];
	metadata: {
		sample_id: string;
		session_id: string;
		type: "dialog" | "observation" | "session_summary";
	};
}
