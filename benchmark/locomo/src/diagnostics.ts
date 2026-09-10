import { createHash } from "node:crypto";

import type { MemorySearchResponse } from "./opencontext-client";
import type {
	LoCoMoFailureStage,
	LoCoMoRetrievalTrace,
	LoCoMoSessionTrace,
	Prediction,
	QAPair,
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

/** Extract LoCoMo dialog-turn references such as D1:3 from source text. */
export function extractEvidenceIds(content: string): string[] {
	return unique(content.match(/\b[A-Za-z]\d+:\d+\b/g) ?? []);
}

export function buildRetrievalTrace(input: {
	qa: QAPair;
	response: MemorySearchResponse;
	sessionsByMessageId: ReadonlyMap<string, LoCoMoSessionTrace>;
	availableEvidenceIds: readonly string[];
	userId: string;
	topK: number;
	latencyMs: number;
}): LoCoMoRetrievalTrace {
	const requiredIds = unique(input.qa.evidence);
	const requiredSet = new Set(requiredIds);
	const availableSet = new Set(input.availableEvidenceIds);
	const availableRequiredIds = requiredIds.filter((id) => availableSet.has(id));
	const missingEvidenceIds = requiredIds.filter((id) => !availableSet.has(id));
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
			// Match gold references against the returned chunk text. Parent-level
			// metadata can contain every turn in a session and would overstate
			// child-level recall after daemon chunking.
			const evidenceIds = extractEvidenceIds(hit.content);
			const matchedEvidenceIds = evidenceIds.filter((id) => requiredSet.has(id));
			if (trackRetrieved) {
				for (const evidenceId of matchedEvidenceIds) retrievedRequiredIds.add(evidenceId);
			}
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
				evidence_ids: evidenceIds,
				matched_evidence_ids: matchedEvidenceIds,
				relevant: requiredIds.length === 0 ? null : matchedEvidenceIds.length > 0,
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
		const matched = new Set(channelHits.flatMap((hit) => hit.matched_evidence_ids));
		return matched.size / requiredIds.length;
	};

	const relevantHits = hits.filter((hit) => hit.relevant === true);
	const firstRelevantRank = relevantHits[0]?.rank ?? null;
	const retrievalApplicable = requiredIds.length > 0;
	const retrievedEvidenceIds = requiredIds.filter((id) => retrievedRequiredIds.has(id));
	const missedEvidenceIds = requiredIds.filter((id) => !retrievedRequiredIds.has(id));

	return {
		status: "completed",
		query: input.qa.question,
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
		hits,
		retrieval_applicable: retrievalApplicable,
		evidence_granularity: retrievalApplicable ? "dialog_turn" : "unavailable",
		required_evidence_ids: requiredIds,
		available_evidence_ids: availableRequiredIds,
		missing_evidence_ids: missingEvidenceIds,
		retrieved_evidence_ids: retrievedEvidenceIds,
		missed_evidence_ids: missedEvidenceIds,
		dataset_evidence_coverage: retrievalApplicable ? availableRequiredIds.length / requiredIds.length : null,
		evidence_recall_at_k: retrievalApplicable ? retrievedRequiredIds.size / requiredIds.length : null,
		retrievable_evidence_recall_at_k:
			availableRequiredIds.length > 0 ? retrievedRequiredIds.size / availableRequiredIds.length : null,
		all_evidence_retrieved: retrievalApplicable ? retrievedRequiredIds.size === requiredIds.length : null,
		hit_at_k: retrievalApplicable ? (firstRelevantRank === null ? 0 : 1) : null,
		first_relevant_rank: firstRelevantRank,
		mrr: firstRelevantRank === null ? (retrievalApplicable ? 0 : null) : 1 / firstRelevantRank,
		precision_at_k: retrievalApplicable ? relevantHits.length / input.topK : null,
		relevant_hit_precision: retrievalApplicable
			? hits.length === 0
				? 0
				: relevantHits.length / hits.length
			: null,
		semantic_evidence_recall_at_candidate_k: channelRecall(candidateChannels.semantic),
		lexical_evidence_recall_at_candidate_k: channelRecall(candidateChannels.lexical),
		hybrid_evidence_recall_at_candidate_k: channelRecall(candidateChannels.hybrid),
	};
}

export function buildRetrievalErrorTrace(input: {
	qa: QAPair;
	availableEvidenceIds: readonly string[];
	userId: string;
	topK: number;
	latencyMs: number;
	error: string;
}): LoCoMoRetrievalTrace {
	const requiredIds = unique(input.qa.evidence);
	const availableSet = new Set(input.availableEvidenceIds);
	const availableIds = requiredIds.filter((id) => availableSet.has(id));
	const missingIds = requiredIds.filter((id) => !availableSet.has(id));
	return {
		status: "execution_error",
		query: input.qa.question,
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
		response_query: input.qa.question,
		response_sources: [],
		response_count: 0,
		response_warnings: [],
		response_reasoning: null,
		premerge_diagnostics_available: false,
		candidate_channels: { semantic: [], lexical: [], hybrid: [], entity: [] },
		fused_before_rerank: [],
		reranker: null,
		hits: [],
		retrieval_applicable: requiredIds.length > 0,
		evidence_granularity: requiredIds.length > 0 ? "dialog_turn" : "unavailable",
		required_evidence_ids: requiredIds,
		available_evidence_ids: availableIds,
		missing_evidence_ids: missingIds,
		retrieved_evidence_ids: [],
		missed_evidence_ids: requiredIds,
		dataset_evidence_coverage: requiredIds.length > 0 ? availableIds.length / requiredIds.length : null,
		evidence_recall_at_k: null,
		retrievable_evidence_recall_at_k: null,
		all_evidence_retrieved: null,
		hit_at_k: null,
		first_relevant_rank: null,
		mrr: null,
		precision_at_k: null,
		relevant_hit_precision: null,
		semantic_evidence_recall_at_candidate_k: null,
		lexical_evidence_recall_at_candidate_k: null,
		hybrid_evidence_recall_at_candidate_k: null,
		error: input.error,
	};
}

export function deriveFailureStage(input: {
	qa: QAPair;
	retrieval: LoCoMoRetrievalTrace | null;
	correct: boolean;
	executionStage?: "ingest" | "retrieval" | "answerer" | "judge" | "provider";
}): LoCoMoFailureStage {
	if (input.executionStage === "ingest") return "ingest_or_index_error";
	if (input.executionStage === "retrieval") return "retrieval_error";
	if (input.executionStage === "answerer") return "answerer_error";
	if (input.executionStage === "judge") return "judge_error";
	if (input.executionStage === "provider") return "provider_error";
	if (input.correct) return "none";
	if (input.qa.evidence.length === 0) return "gold_evidence_unavailable";
	if ((input.retrieval?.missing_evidence_ids.length ?? 0) > 0) {
		return input.retrieval?.available_evidence_ids.length === 0
			? "dataset_reference_missing"
			: "dataset_reference_partial";
	}
	if (!input.retrieval || input.retrieval.evidence_recall_at_k === 0) return "retrieval_miss";
	if ((input.retrieval.evidence_recall_at_k ?? 0) < 1) return "retrieval_partial";
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
	let questionsWithGoldEvidence = 0;
	let retrievalEvaluable = 0;
	let allEvidenceRetrieved = 0;
	let premergeDiagnostics = 0;

	for (const prediction of predictions) {
		failureStages[prediction.failure_stage] = (failureStages[prediction.failure_stage] ?? 0) + 1;
		if (prediction.status === "completed") completed++;
		else executionErrors++;
		if ((prediction.evidence?.length ?? 0) > 0) questionsWithGoldEvidence++;
		const retrieval = prediction.trace.retrieval;
		if (retrieval?.premerge_diagnostics_available) premergeDiagnostics++;
		if (!retrieval?.retrieval_applicable) continue;
		if (retrieval.status !== "completed") continue;
		retrievalEvaluable++;
		if (retrieval.all_evidence_retrieved) allEvidenceRetrieved++;
		if (retrieval.evidence_recall_at_k !== null) recalls.push(retrieval.evidence_recall_at_k);
		if (retrieval.retrievable_evidence_recall_at_k !== null)
			retrievableRecalls.push(retrieval.retrievable_evidence_recall_at_k);
		if (retrieval.dataset_evidence_coverage !== null)
			sourceCoverages.push(retrieval.dataset_evidence_coverage);
		if (retrieval.hit_at_k !== null) hitAtK.push(retrieval.hit_at_k);
		if (retrieval.mrr !== null) reciprocalRanks.push(retrieval.mrr);
		if (retrieval.precision_at_k !== null) precisionAtK.push(retrieval.precision_at_k);
		if (retrieval.semantic_evidence_recall_at_candidate_k !== null)
			semanticCandidateRecalls.push(retrieval.semantic_evidence_recall_at_candidate_k);
		if (retrieval.lexical_evidence_recall_at_candidate_k !== null)
			lexicalCandidateRecalls.push(retrieval.lexical_evidence_recall_at_candidate_k);
		if (retrieval.hybrid_evidence_recall_at_candidate_k !== null)
			hybridCandidateRecalls.push(retrieval.hybrid_evidence_recall_at_candidate_k);
	}

	const mean = (values: number[]): number | null =>
		values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
	return {
		completed,
		execution_errors: executionErrors,
		execution_error_rate: predictions.length === 0 ? 0 : executionErrors / predictions.length,
		failure_stages: failureStages,
		questions_with_gold_evidence: questionsWithGoldEvidence,
		questions_without_gold_evidence: predictions.length - questionsWithGoldEvidence,
		retrieval_evaluable_questions: retrievalEvaluable,
		premerge_diagnostics_questions: premergeDiagnostics,
		mean_semantic_evidence_recall_at_candidate_k: mean(semanticCandidateRecalls),
		mean_lexical_evidence_recall_at_candidate_k: mean(lexicalCandidateRecalls),
		mean_hybrid_evidence_recall_at_candidate_k: mean(hybridCandidateRecalls),
		mean_evidence_recall_at_k: mean(recalls),
		mean_retrievable_evidence_recall_at_k: mean(retrievableRecalls),
		mean_dataset_evidence_coverage: mean(sourceCoverages),
		hit_at_k_rate: mean(hitAtK),
		mean_precision_at_k: mean(precisionAtK),
		mean_reciprocal_rank: mean(reciprocalRanks),
		all_evidence_retrieved_rate: retrievalEvaluable === 0 ? null : allEvidenceRetrieved / retrievalEvaluable,
	};
}
