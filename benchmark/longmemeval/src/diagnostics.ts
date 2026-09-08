import { createHash } from "node:crypto";

import type { MemorySearchResponse } from "./opencontext-client";
import type {
	LongMemEvalEntry,
	LongMemEvalFailureStage,
	LongMemEvalRetrievalTrace,
	LongMemEvalSessionTrace,
	Prediction,
} from "./types";

export function sha256Text(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function optionalString(value: unknown): string[] {
	return typeof value === "string" ? [value] : [];
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

export function buildRetrievalTrace(input: {
	entry: LongMemEvalEntry;
	response: MemorySearchResponse;
	sessionsByMessageId: ReadonlyMap<string, LongMemEvalSessionTrace>;
	userId: string;
	topK: number;
	latencyMs: number;
}): LongMemEvalRetrievalTrace {
	const requiredIds = unique(input.entry.answer_session_ids);
	const requiredSet = new Set(requiredIds);
	const availableSet = new Set(input.entry.haystack_session_ids);
	const availableRequiredIds = requiredIds.filter((id) => availableSet.has(id));
	const missingSessionIds = requiredIds.filter((id) => !availableSet.has(id));
	const retrievedRequiredIds = new Set<string>();

	const mapHits = (sourceHits: MemorySearchResponse["results"], trackRetrieved: boolean) =>
		sourceHits.map((hit, index) => {
			const localSession = input.sessionsByMessageId.get(hit.id);
			const sessionIds = unique([
				...optionalString(hit.metadata.sessionId),
				...optionalString(hit.metadata.session_id),
				...stringArray(hit.metadata.sessionIds),
				...stringArray(hit.metadata.session_ids),
				...(localSession ? [localSession.session_id] : []),
			]);
			if (trackRetrieved) {
				for (const sessionId of sessionIds) {
					if (requiredSet.has(sessionId)) retrievedRequiredIds.add(sessionId);
				}
			}
			const matchedAnswerSessionIds = sessionIds.filter((id) => requiredSet.has(id));
			const relevant = requiredIds.length === 0 ? null : matchedAnswerSessionIds.length > 0;
			return {
				rank: index + 1,
				id: hit.id,
				similarity: hit.similarity,
				signals: hit.signals ?? null,
				metadata: hit.metadata,
				content_sha256: sha256Text(hit.content),
				content_characters: hit.content.length,
				content_excerpt: hit.content.replace(/\s+/g, " ").trim().slice(0, 240),
				...(trackRetrieved ? { content: hit.content } : {}),
				session_ids: sessionIds,
				matched_answer_session_ids: matchedAnswerSessionIds,
				relevant,
			};
		});

	const hits = mapHits(input.response.results, true);
	const diagnostics = input.response.retrievalDiagnostics;
	const candidateChannels = {
		semantic: mapHits(diagnostics?.channels.semantic ?? [], false),
		lexical: mapHits(diagnostics?.channels.lexical ?? [], false),
		hybrid: mapHits(diagnostics?.channels.hybrid ?? [], false),
		entity: mapHits(diagnostics?.channels.entity ?? [], false),
	};
	const fusedBeforeRerank = mapHits(diagnostics?.fusedBeforeRerank ?? [], false);
	const channelRecall = (channelHits: typeof candidateChannels.semantic): number | null => {
		if (requiredIds.length === 0) return null;
		const matched = new Set(channelHits.flatMap((hit) => hit.matched_answer_session_ids));
		return matched.size / requiredIds.length;
	};

	const relevantHits = hits.filter((hit) => hit.relevant === true);
	const firstRelevantRank = relevantHits[0]?.rank ?? null;
	const retrievalApplicable = requiredIds.length > 0;
	const retrievedSessionIds = requiredIds.filter((id) => retrievedRequiredIds.has(id));
	const missedSessionIds = requiredIds.filter((id) => !retrievedRequiredIds.has(id));

	return {
		status: "completed",
		query: input.entry.question,
		user_id: input.userId,
		top_k: input.topK,
		candidate_k: diagnostics?.candidateLimit ?? null,
		strategy: "daemon-default",
		merge_strategy: diagnostics?.mergeStrategy ?? null,
		threshold: null,
		backend: diagnostics?.backend ?? null,
		semantic_degraded_reason: diagnostics?.semanticDegradedReason ?? null,
		candidate_counts: diagnostics?.candidateCounts ?? null,
		latency_ms: input.latencyMs,
		response_query: input.response.query,
		response_sources: input.response.sources,
		response_count: input.response.count,
		response_warnings: input.response.warnings,
		response_reasoning: input.response.reasoning ?? null,
		premerge_diagnostics_available: diagnostics !== undefined,
		candidate_channels: candidateChannels,
		fused_before_rerank: fusedBeforeRerank,
		reranker: diagnostics?.reranker
			? {
					enabled: diagnostics.reranker.enabled,
					provider: diagnostics.reranker.provider ?? null,
					model: diagnostics.reranker.model ?? null,
					input_count: diagnostics.reranker.inputCount,
					output_count: diagnostics.reranker.outputCount,
					latency_ms: diagnostics.reranker.latencyMs,
					order_changed: diagnostics.reranker.orderChanged,
				}
			: null,
		semantic_answer_session_recall_at_candidate_k: channelRecall(candidateChannels.semantic),
		lexical_answer_session_recall_at_candidate_k: channelRecall(candidateChannels.lexical),
		hybrid_answer_session_recall_at_candidate_k: channelRecall(candidateChannels.hybrid),
		hits,
		retrieval_applicable: retrievalApplicable,
		required_answer_session_ids: requiredIds,
		available_answer_session_ids: availableRequiredIds,
		missing_answer_session_ids: missingSessionIds,
		retrieved_answer_session_ids: retrievedSessionIds,
		missed_answer_session_ids: missedSessionIds,
		dataset_source_coverage: retrievalApplicable ? availableRequiredIds.length / requiredIds.length : null,
		answer_session_recall_at_k: retrievalApplicable ? retrievedRequiredIds.size / requiredIds.length : null,
		retrievable_answer_session_recall_at_k:
			availableRequiredIds.length > 0 ? retrievedRequiredIds.size / availableRequiredIds.length : null,
		all_answer_sessions_retrieved: retrievalApplicable
			? retrievedRequiredIds.size === requiredIds.length
			: null,
		hit_at_k: retrievalApplicable ? (firstRelevantRank === null ? 0 : 1) : null,
		first_relevant_rank: firstRelevantRank,
		mrr: firstRelevantRank === null ? (retrievalApplicable ? 0 : null) : 1 / firstRelevantRank,
		precision_at_k: retrievalApplicable ? relevantHits.length / input.topK : null,
		relevant_hit_precision: retrievalApplicable
			? hits.length === 0
				? 0
				: relevantHits.length / hits.length
			: null,
	};
}

export function buildRetrievalErrorTrace(input: {
	entry: LongMemEvalEntry;
	userId: string;
	topK: number;
	latencyMs: number;
	error: string;
}): LongMemEvalRetrievalTrace {
	const requiredIds = unique(input.entry.answer_session_ids);
	const availableSet = new Set(input.entry.haystack_session_ids);
	const availableIds = requiredIds.filter((id) => availableSet.has(id));
	const missingIds = requiredIds.filter((id) => !availableSet.has(id));
	return {
		status: "execution_error",
		query: input.entry.question,
		user_id: input.userId,
		top_k: input.topK,
		candidate_k: null,
		strategy: "daemon-default",
		merge_strategy: null,
		threshold: null,
		backend: null,
		semantic_degraded_reason: null,
		candidate_counts: null,
		latency_ms: input.latencyMs,
		response_query: input.entry.question,
		response_sources: [],
		response_count: 0,
		response_warnings: [],
		response_reasoning: null,
		premerge_diagnostics_available: false,
		candidate_channels: { semantic: [], lexical: [], hybrid: [], entity: [] },
		fused_before_rerank: [],
		reranker: null,
		semantic_answer_session_recall_at_candidate_k: null,
		lexical_answer_session_recall_at_candidate_k: null,
		hybrid_answer_session_recall_at_candidate_k: null,
		hits: [],
		retrieval_applicable: requiredIds.length > 0,
		required_answer_session_ids: requiredIds,
		available_answer_session_ids: availableIds,
		missing_answer_session_ids: missingIds,
		retrieved_answer_session_ids: [],
		missed_answer_session_ids: requiredIds,
		dataset_source_coverage: requiredIds.length > 0 ? availableIds.length / requiredIds.length : null,
		answer_session_recall_at_k: null,
		retrievable_answer_session_recall_at_k: null,
		all_answer_sessions_retrieved: null,
		hit_at_k: null,
		first_relevant_rank: null,
		mrr: null,
		precision_at_k: null,
		relevant_hit_precision: null,
		error: input.error,
	};
}

export function deriveFailureStage(input: {
	entry: LongMemEvalEntry;
	retrieval: LongMemEvalRetrievalTrace | null;
	correct: boolean;
	executionStage?: "ingest" | "retrieval" | "answerer" | "judge" | "provider";
}): LongMemEvalFailureStage {
	if (input.executionStage === "ingest") return "ingest_or_index_error";
	if (input.executionStage === "retrieval") return "retrieval_error";
	if (input.executionStage === "answerer") return "answerer_error";
	if (input.executionStage === "judge") return "judge_error";
	if (input.executionStage === "provider") return "provider_error";
	if (input.correct) return "none";
	if (input.entry.answer_session_ids.length === 0) return "dataset_reference_missing";
	if ((input.retrieval?.missing_answer_session_ids.length ?? 0) > 0) {
		return input.retrieval?.available_answer_session_ids.length === 0
			? "dataset_reference_missing"
			: "dataset_reference_partial";
	}
	if (!input.retrieval || input.retrieval.answer_session_recall_at_k === 0) return "retrieval_miss";
	if ((input.retrieval.answer_session_recall_at_k ?? 0) < 1) return "retrieval_partial";
	return "context_present_answer_failed";
}

export function calculateDiagnosticSummary(predictions: Prediction[]): Record<string, unknown> {
	const failureStages: Record<string, number> = {};
	const recalls: number[] = [];
	const retrievableRecalls: number[] = [];
	const sourceCoverages: number[] = [];
	const hitAtK: number[] = [];
	const reciprocalRanks: number[] = [];
	const precisionAtK: number[] = [];
	const semanticCandidateRecalls: number[] = [];
	const lexicalCandidateRecalls: number[] = [];
	const hybridCandidateRecalls: number[] = [];
	let completed = 0;
	let executionErrors = 0;
	let retrievalApplicable = 0;
	let allSessionsRetrieved = 0;
	let premergeDiagnostics = 0;

	for (const prediction of predictions) {
		failureStages[prediction.failure_stage] = (failureStages[prediction.failure_stage] ?? 0) + 1;
		if (prediction.status === "completed") completed++;
		else executionErrors++;
		const retrieval = prediction.trace.retrieval;
		if (retrieval?.premerge_diagnostics_available) premergeDiagnostics++;
		if (!retrieval?.retrieval_applicable) continue;
		retrievalApplicable++;
		if (retrieval.all_answer_sessions_retrieved) allSessionsRetrieved++;
		if (retrieval.answer_session_recall_at_k !== null) recalls.push(retrieval.answer_session_recall_at_k);
		if (retrieval.retrievable_answer_session_recall_at_k !== null)
			retrievableRecalls.push(retrieval.retrievable_answer_session_recall_at_k);
		if (retrieval.dataset_source_coverage !== null) sourceCoverages.push(retrieval.dataset_source_coverage);
		if (retrieval.hit_at_k !== null) hitAtK.push(retrieval.hit_at_k);
		if (retrieval.mrr !== null) reciprocalRanks.push(retrieval.mrr);
		if (retrieval.precision_at_k !== null) precisionAtK.push(retrieval.precision_at_k);
		if (retrieval.semantic_answer_session_recall_at_candidate_k !== null)
			semanticCandidateRecalls.push(retrieval.semantic_answer_session_recall_at_candidate_k);
		if (retrieval.lexical_answer_session_recall_at_candidate_k !== null)
			lexicalCandidateRecalls.push(retrieval.lexical_answer_session_recall_at_candidate_k);
		if (retrieval.hybrid_answer_session_recall_at_candidate_k !== null)
			hybridCandidateRecalls.push(retrieval.hybrid_answer_session_recall_at_candidate_k);
	}

	const mean = (values: number[]): number | null =>
		values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
	return {
		completed,
		execution_errors: executionErrors,
		execution_error_rate: predictions.length === 0 ? 0 : executionErrors / predictions.length,
		failure_stages: failureStages,
		retrieval_applicable_questions: retrievalApplicable,
		premerge_diagnostics_questions: premergeDiagnostics,
		mean_semantic_answer_session_recall_at_candidate_k: mean(semanticCandidateRecalls),
		mean_lexical_answer_session_recall_at_candidate_k: mean(lexicalCandidateRecalls),
		mean_hybrid_answer_session_recall_at_candidate_k: mean(hybridCandidateRecalls),
		mean_answer_session_recall_at_k: mean(recalls),
		mean_retrievable_answer_session_recall_at_k: mean(retrievableRecalls),
		mean_dataset_source_coverage: mean(sourceCoverages),
		hit_at_k_rate: mean(hitAtK),
		mean_precision_at_k: mean(precisionAtK),
		mean_reciprocal_rank: mean(reciprocalRanks),
		all_answer_sessions_retrieved_rate:
			retrievalApplicable === 0 ? null : allSessionsRetrieved / retrievalApplicable,
	};
}
