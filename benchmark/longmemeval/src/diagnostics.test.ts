import { describe, expect, it } from "vitest";

import { buildRetrievalTrace, calculateDiagnosticSummary, deriveFailureStage } from "./diagnostics";
import type { MemorySearchResponse } from "./opencontext-client";
import { LONGMEMEVAL_TRACE_SCHEMA_VERSION } from "./types";
import type { LongMemEvalEntry, LongMemEvalSessionTrace, Prediction } from "./types";

function entry(): LongMemEvalEntry {
	return {
		question_id: "q1",
		question_type: "multi-session",
		question: "What pets did I adopt?",
		question_date: "2024-02-01",
		answer: "Luna and Milo",
		answer_session_ids: ["s1", "s2"],
		haystack_dates: ["2024-01-01", "2024-01-02"],
		haystack_session_ids: ["s1", "s2"],
		haystack_sessions: [[], []],
	};
}

function session(messageId: string, sessionId: string): LongMemEvalSessionTrace {
	return {
		schema_version: LONGMEMEVAL_TRACE_SCHEMA_VERSION,
		question_id: "q1",
		message_id: messageId,
		session_id: sessionId,
		session_index: 0,
		ingest_batch_index: 0,
		session_date: "2024-01-01",
		turn_count: 1,
		content_sha256: "hash",
		content_characters: 10,
		ingest_status: "completed",
		ingest_latency_ms: 5,
		ingest_warnings: [],
	};
}

describe("LongMemEval retrieval evidence", () => {
	it("maps final daemon hits and pre-rerank channels back to gold sessions", () => {
		const response: MemorySearchResponse = {
			query: "What pets did I adopt?",
			sources: ["memory"],
			count: 2,
			warnings: [],
			results: [
				{ id: "m2", content: "I adopted Milo.", similarity: 0.91, metadata: { sessionId: "s2" } },
				{ id: "noise", content: "Unrelated", similarity: 0.7, metadata: { sessionId: "s9" } },
			],
			retrievalDiagnostics: {
				mergeStrategy: "rrf",
				candidateLimit: 20,
				backend: "raw-message",
				candidateCounts: { semantic: 2, lexical: 1, hybrid: 0, entity: 0, fused: 2, final: 2 },
				channels: {
					semantic: [
						{ id: "m1", content: "I adopted Luna.", similarity: 0.8, metadata: { sessionId: "s1" } },
					],
					lexical: [],
				},
				fusedBeforeRerank: [
					{ id: "m1", content: "I adopted Luna.", similarity: 0.8, metadata: { sessionId: "s1" } },
					{ id: "m2", content: "I adopted Milo.", similarity: 0.7, metadata: { sessionId: "s2" } },
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
			["m1", session("m1", "s1")],
			["m2", session("m2", "s2")],
		]);

		const trace = buildRetrievalTrace({
			entry: entry(),
			response,
			sessionsByMessageId: sessions,
			userId: "longmemeval_v1_q1",
			topK: 8,
			latencyMs: 20,
		});

		expect(trace.hits[0]).toMatchObject({
			rank: 1,
			session_ids: ["s2"],
			matched_answer_session_ids: ["s2"],
			relevant: true,
		});
		expect(trace.hits[0]?.content).toBe("I adopted Milo.");
		expect(trace.candidate_channels.semantic[0]?.content).toBeUndefined();
		expect(trace.semantic_answer_session_recall_at_candidate_k).toBe(0.5);
		expect(trace.answer_session_recall_at_k).toBe(0.5);
		expect(trace.hit_at_k).toBe(1);
		expect(trace.mrr).toBe(1);
		expect(trace.reranker).toMatchObject({ enabled: true, order_changed: true });
		expect(deriveFailureStage({ entry: entry(), retrieval: trace, correct: false })).toBe(
			"retrieval_partial",
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
			failure_stages: { answerer_error: 1 },
		});
	});
});
