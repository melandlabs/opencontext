import { createHash } from "node:crypto";

import type { MemorySearchResponse } from "./opencontext-client";
import type {
	BeamAnswerTrace,
	BeamChunkTrace,
	BeamFailureStage,
	BeamProbingQuestion,
	BeamRetrievalTrace,
	Prediction,
} from "./types";

export function sha256Text(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

export function buildRetrievalTrace(input: {
	question: BeamProbingQuestion;
	response: MemorySearchResponse;
	chunksByMessageId: ReadonlyMap<string, BeamChunkTrace>;
	availableSourceTurnIds: readonly string[];
	userId: string;
	topK: number;
	latencyMs: number;
}): BeamRetrievalTrace {
	const requiredIds = unique(input.question.source.source_chat_ids);
	const requiredSet = new Set(requiredIds);
	const availableSet = new Set(input.availableSourceTurnIds);
	const availableRequiredIds = requiredIds.filter((id) => availableSet.has(id));
	const missingSourceIds = requiredIds.filter((id) => !availableSet.has(id));
	const retrievedRequiredIds = new Set<string>();

	const hits = input.response.results.map((hit, index) => {
		const localChunk = input.chunksByMessageId.get(hit.id);
		const sourceTurnIds = unique([
			...stringArray(hit.metadata.sourceTurnIds),
			...stringArray(hit.metadata.source_turn_ids),
			...(localChunk?.source_turn_ids ?? []),
		]);
		for (const sourceId of sourceTurnIds) {
			if (requiredSet.has(sourceId)) retrievedRequiredIds.add(sourceId);
		}
		const matchedSourceTurnIds = sourceTurnIds.filter((id) => requiredSet.has(id));
		const relevant = requiredIds.length === 0 ? null : matchedSourceTurnIds.length > 0;
		return {
			rank: index + 1,
			id: hit.id,
			similarity: hit.similarity,
			signals: hit.signals ?? null,
			metadata: hit.metadata,
			content_sha256: sha256Text(hit.content),
			content_characters: hit.content.length,
			content_excerpt: hit.content.replace(/\s+/g, " ").trim().slice(0, 240),
			content: hit.content,
			source_turn_ids: sourceTurnIds,
			matched_source_turn_ids: matchedSourceTurnIds,
			relevant,
		};
	});

	const relevantHits = hits.filter((hit) => hit.relevant === true);
	const firstRelevantRank = relevantHits[0]?.rank ?? null;
	const retrievalApplicable = requiredIds.length > 0;
	const retrievedSourceIds = requiredIds.filter((id) => retrievedRequiredIds.has(id));
	const missedSourceIds = requiredIds.filter((id) => !retrievedRequiredIds.has(id));

	return {
		status: "completed",
		query: input.question.question,
		user_id: input.userId,
		top_k: input.topK,
		strategy: "daemon-default",
		latency_ms: input.latencyMs,
		response_query: input.response.query,
		response_sources: input.response.sources,
		response_count: input.response.count,
		response_warnings: input.response.warnings,
		response_reasoning: input.response.reasoning ?? null,
		hits,
		retrieval_applicable: retrievalApplicable,
		required_source_turn_ids: requiredIds,
		available_source_turn_ids: availableRequiredIds,
		missing_source_turn_ids: missingSourceIds,
		retrieved_source_turn_ids: retrievedSourceIds,
		missed_source_turn_ids: missedSourceIds,
		dataset_source_coverage: retrievalApplicable ? availableRequiredIds.length / requiredIds.length : null,
		source_recall_at_k: retrievalApplicable ? retrievedRequiredIds.size / requiredIds.length : null,
		retrievable_source_recall_at_k:
			availableRequiredIds.length > 0 ? retrievedRequiredIds.size / availableRequiredIds.length : null,
		all_required_sources_retrieved: retrievalApplicable
			? retrievedRequiredIds.size === requiredIds.length
			: null,
		first_relevant_rank: firstRelevantRank,
		hit_at_k: retrievalApplicable ? (firstRelevantRank === null ? 0 : 1) : null,
		mrr: firstRelevantRank === null ? (retrievalApplicable ? 0 : null) : 1 / firstRelevantRank,
		precision_at_k: retrievalApplicable ? relevantHits.length / input.topK : null,
		relevant_hit_precision: retrievalApplicable
			? hits.length === 0
				? 0
				: relevantHits.length / hits.length
			: null,
	};
}

export function buildAnswerAttribution(
	answer: string,
	retrieval: BeamRetrievalTrace,
): Pick<BeamAnswerTrace, "cited_hit_ids" | "cited_relevant_hit_ids" | "attribution_status"> {
	const citedRanks = new Set<number>();
	for (const pattern of [/\b(?:memory\s+)?excerpt\s+#?(\d+)\b/gi, /\[(\d+)\]/g]) {
		for (const match of answer.matchAll(pattern)) {
			const rank = Number.parseInt(match[1] ?? "", 10);
			if (Number.isInteger(rank) && rank >= 1 && rank <= retrieval.hits.length) citedRanks.add(rank);
		}
	}
	const citedHits = retrieval.hits.filter((hit) => citedRanks.has(hit.rank));
	const citedRelevantHits = citedHits.filter((hit) => hit.relevant === true);
	let attributionStatus: BeamAnswerTrace["attribution_status"];
	if (!retrieval.retrieval_applicable) attributionStatus = "not_applicable";
	else if (citedHits.length === 0) attributionStatus = "uncited";
	else if (citedRelevantHits.length > 0) attributionStatus = "supported";
	else attributionStatus = "unsupported";
	return {
		cited_hit_ids: citedHits.map((hit) => hit.id),
		cited_relevant_hit_ids: citedRelevantHits.map((hit) => hit.id),
		attribution_status: attributionStatus,
	};
}

export function deriveFailureStage(input: {
	question: BeamProbingQuestion;
	retrieval: BeamRetrievalTrace | null;
	nuggetPass: boolean;
	executionStage?: "ingest" | "retrieval" | "answerer" | "judge" | "provider";
}): BeamFailureStage {
	if (input.executionStage === "ingest") return "ingest_or_index_error";
	if (input.executionStage === "retrieval") return "retrieval_error";
	if (input.executionStage === "answerer") return "answerer_error";
	if (input.executionStage === "judge") return "judge_error";
	if (input.executionStage === "provider") return "provider_error";
	if (input.nuggetPass) return "none";
	if (input.question.category === "abstention" && input.question.source.source_chat_ids.length === 0) {
		return input.nuggetPass ? "none" : "context_present_answer_failed";
	}
	if (input.question.source.source_chat_ids.length === 0) return "dataset_reference_missing";
	if ((input.retrieval?.missing_source_turn_ids.length ?? 0) > 0) {
		return input.retrieval?.available_source_turn_ids.length === 0
			? "dataset_reference_missing"
			: "dataset_reference_partial";
	}
	if (!input.retrieval || input.retrieval.source_recall_at_k === 0) return "retrieval_miss";
	if ((input.retrieval.source_recall_at_k ?? 0) < 1) return "retrieval_partial";
	return "context_present_answer_failed";
}

export function calculateDiagnosticSummary(predictions: Prediction[]): Record<string, unknown> {
	const failureStages: Record<string, number> = {};
	const retrievalRecalls: number[] = [];
	const reciprocalRanks: number[] = [];
	const retrievableRecalls: number[] = [];
	const sourceCoverages: number[] = [];
	const hitAtK: number[] = [];
	const precisionAtK: number[] = [];
	let completed = 0;
	let executionErrors = 0;
	let retrievalApplicable = 0;
	let allSourcesRetrieved = 0;

	for (const prediction of predictions) {
		failureStages[prediction.failure_stage] = (failureStages[prediction.failure_stage] ?? 0) + 1;
		if (prediction.status === "completed") completed++;
		else executionErrors++;
		const retrieval = prediction.trace.retrieval;
		if (retrieval?.retrieval_applicable) {
			retrievalApplicable++;
			if (retrieval.all_required_sources_retrieved) allSourcesRetrieved++;
			if (retrieval.source_recall_at_k !== null) retrievalRecalls.push(retrieval.source_recall_at_k);
			if (retrieval.retrievable_source_recall_at_k !== null)
				retrievableRecalls.push(retrieval.retrievable_source_recall_at_k);
			if (retrieval.dataset_source_coverage !== null) sourceCoverages.push(retrieval.dataset_source_coverage);
			if (retrieval.hit_at_k !== null) hitAtK.push(retrieval.hit_at_k);
			if (retrieval.precision_at_k !== null) precisionAtK.push(retrieval.precision_at_k);
			if (retrieval.mrr !== null) reciprocalRanks.push(retrieval.mrr);
		}
	}

	const mean = (values: number[]): number | null =>
		values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
	return {
		completed,
		execution_errors: executionErrors,
		failure_stages: failureStages,
		retrieval_applicable_questions: retrievalApplicable,
		mean_source_recall_at_k: mean(retrievalRecalls),
		mean_retrievable_source_recall_at_k: mean(retrievableRecalls),
		mean_dataset_source_coverage: mean(sourceCoverages),
		hit_at_k_rate: mean(hitAtK),
		mean_precision_at_k: mean(precisionAtK),
		mean_reciprocal_rank: mean(reciprocalRanks),
		all_required_sources_retrieved_rate:
			retrievalApplicable === 0 ? null : allSourcesRetrieved / retrievalApplicable,
	};
}
