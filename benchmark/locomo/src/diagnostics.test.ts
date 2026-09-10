import { describe, expect, it } from "vitest";

import {
	buildRetrievalErrorTrace,
	buildRetrievalTrace,
	calculateDiagnosticSummary,
	deriveFailureStage,
} from "./diagnostics";
import type { MemorySearchResponse } from "./opencontext-client";
import {
	LOCOMO_TRACE_SCHEMA_VERSION,
	type LoCoMoSessionTrace,
	type Prediction,
	type QAPair,
	RetrievalMode,
} from "./types";

function qa(evidence: string[] = ["D1:3", "D2:1"]): QAPair {
	return { question: "What pets were adopted?", answer: "Luna and Milo", category: 3, evidence };
}

function session(messageId: string, sessionId: string, evidenceIds: string[]): LoCoMoSessionTrace {
	return {
		schema_version: LOCOMO_TRACE_SCHEMA_VERSION,
		sample_id: "fixture-sample",
		retrieval_mode: RetrievalMode.DIALOG,
		message_id: messageId,
		session_id: sessionId,
		session_index: 0,
		ingest_batch_index: 0,
		session_date: "2024-01-01",
		evidence_ids: evidenceIds,
		content_sha256: "hash",
		content_characters: 10,
		ingest_status: "completed",
		ingest_latency_ms: 5,
		ingest_warnings: [],
	};
}

describe("LoCoMo retrieval evidence", () => {
	it("records daemon candidates, reranking, and exact turn-level gold matches", () => {
		const response: MemorySearchResponse = {
			query: "What pets were adopted?",
			sources: ["memory"],
			count: 2,
			warnings: [],
			results: [
				{
					id: "child-2",
					content: "[D2:1] I adopted Milo.",
					similarity: 0.91,
					metadata: { parentMessageId: "message-2", sessionId: "2" },
				},
				{
					id: "child-noise",
					content: "Unrelated text",
					similarity: 0.7,
					metadata: { sessionId: "1", evidenceIds: ["D1:3"] },
				},
			],
			retrievalDiagnostics: {
				mergeStrategy: "rrf",
				candidateLimit: 20,
				backend: "raw-message",
				candidateCounts: { semantic: 2, lexical: 1, hybrid: 0, entity: 0, fused: 2, final: 2 },
				channels: {
					semantic: [{ id: "child-1", content: "[D1:3] I adopted Luna.", similarity: 0.8, metadata: {} }],
					lexical: [],
				},
				fusedBeforeRerank: [
					{ id: "child-1", content: "[D1:3] I adopted Luna.", similarity: 0.8, metadata: {} },
					{ id: "child-2", content: "[D2:1] I adopted Milo.", similarity: 0.7, metadata: {} },
				],
				reranker: {
					enabled: true,
					provider: "local-transformers",
					model: "reranker",
					inputCount: 2,
					outputCount: 2,
					latencyMs: 12,
					orderChanged: true,
				},
			},
		};
		const sessions = new Map([
			["message-1", session("message-1", "1", ["D1:3"])],
			["message-2", session("message-2", "2", ["D2:1"])],
		]);

		const trace = buildRetrievalTrace({
			qa: qa(),
			response,
			sessionsByMessageId: sessions,
			availableEvidenceIds: ["D1:3", "D2:1"],
			userId: "locomo_fixture-sample",
			topK: 8,
			latencyMs: 20,
		});

		expect(trace.hits[0]).toMatchObject({
			rank: 1,
			matched_evidence_ids: ["D2:1"],
			relevant: true,
		});
		expect(trace.hits[0]?.content).toBe("[D2:1] I adopted Milo.");
		expect(trace.candidate_channels.semantic[0]?.content).toBeUndefined();
		expect(trace.semantic_evidence_recall_at_candidate_k).toBe(0.5);
		expect(trace.evidence_recall_at_k).toBe(0.5);
		expect(trace.hit_at_k).toBe(1);
		expect(trace.mrr).toBe(1);
		expect(trace.reranker).toMatchObject({ enabled: true, order_changed: true });
		expect(deriveFailureStage({ qa: qa(), retrieval: trace, correct: false })).toBe("retrieval_partial");
	});

	it("does not count parent metadata when the returned child text lacks the gold turn", () => {
		const trace = buildRetrievalTrace({
			qa: qa(["D1:3"]),
			response: {
				query: "fixture",
				sources: ["memory"],
				count: 1,
				warnings: [],
				results: [
					{
						id: "child-noise",
						content: "A different child chunk",
						similarity: 0.9,
						metadata: { evidenceIds: ["D1:3"] },
					},
				],
			},
			sessionsByMessageId: new Map(),
			availableEvidenceIds: ["D1:3"],
			userId: "locomo_fixture-sample",
			topK: 8,
			latencyMs: 5,
		});

		expect(trace.hits[0]).toMatchObject({ matched_evidence_ids: [], relevant: false });
		expect(trace.evidence_recall_at_k).toBe(0);
	});

	it("marks V2 questions without gold evidence as unavailable", () => {
		const trace = buildRetrievalTrace({
			qa: qa([]),
			response: { query: "fixture", sources: ["memory"], results: [], count: 0, warnings: [] },
			sessionsByMessageId: new Map(),
			availableEvidenceIds: [],
			userId: "locomo_fixture-sample",
			topK: 8,
			latencyMs: 5,
		});

		expect(trace).toMatchObject({
			retrieval_applicable: false,
			evidence_granularity: "unavailable",
			evidence_recall_at_k: null,
			mrr: null,
		});
		expect(deriveFailureStage({ qa: qa([]), retrieval: trace, correct: false })).toBe(
			"gold_evidence_unavailable",
		);
	});

	it("keeps execution errors separate in the diagnostic summary", () => {
		const prediction = {
			status: "execution_error",
			failure_stage: "answerer_error",
			trace: { retrieval: null, answerer: null, judge: null },
		} as Prediction;

		expect(calculateDiagnosticSummary([prediction])).toMatchObject({
			completed: 0,
			execution_errors: 1,
			execution_error_rate: 1,
			questions_with_gold_evidence: 0,
			retrieval_evaluable_questions: 0,
			mean_evidence_recall_at_k: null,
			failure_stages: { answerer_error: 1 },
		});
	});

	it("excludes failed retrieval calls from retrieval metric denominators", () => {
		const retrieval = buildRetrievalErrorTrace({
			qa: qa(["D1:3"]),
			availableEvidenceIds: ["D1:3"],
			userId: "locomo_fixture-sample",
			topK: 8,
			latencyMs: 5,
			error: "timeout",
		});
		const prediction = {
			status: "execution_error",
			evidence: ["D1:3"],
			failure_stage: "retrieval_error",
			trace: { retrieval, answerer: null, judge: null },
		} as Prediction;

		expect(calculateDiagnosticSummary([prediction])).toMatchObject({
			questions_with_gold_evidence: 1,
			retrieval_evaluable_questions: 0,
			mean_evidence_recall_at_k: null,
			all_evidence_retrieved_rate: null,
		});
	});
});
