import assert from "node:assert/strict";
import test from "node:test";

import {
	buildAnswerAttribution,
	buildRetrievalTrace,
	calculateDiagnosticSummary,
	deriveFailureStage,
} from "./diagnostics";
import { buildConversationMessages } from "./evaluator";
import { summarizeNuggetScores } from "./metrics";
import { IngestMessagesError, ingestMessages, searchMemory } from "./opencontext-client";
import {
	BEAM_TRACE_SCHEMA_VERSION,
	type BeamProbingQuestion,
	type BeamRetrievalTrace,
	type Prediction,
} from "./types";

const question: BeamProbingQuestion = {
	question_id: "q-1",
	category: "information_extraction",
	question: "Which city?",
	atoms: ["Berlin"],
	gold_answer: "Berlin",
	source: {
		source_chat_ids: ["41", "80"],
		conversation_references: ["chat_id: 41", "chat_id: 80"],
		plan_references: [],
	},
};

test("chunk manifest preserves upstream turn ids", () => {
	const built = buildConversationMessages({
		entry_id: "conv-1",
		scale: "128k",
		chat: [
			{ speaker: "user", text: "Berlin", source_id: "41" },
			{ speaker: "assistant", text: "Noted", source_id: "42" },
		],
		probing_questions: [question],
	});

	assert.equal(built.messages.length, 1);
	assert.deepEqual(built.messages[0]?.metadata?.sourceTurnIds, ["41", "42"]);
	assert.deepEqual(built.chunks[0]?.source_turn_ids, ["41", "42"]);
	assert.equal(built.chunks[0]?.content_sha256.length, 64);
});

test("retrieval diagnostics map ranked hits back to required source turns", () => {
	const chunks = new Map([
		[
			"chunk-1",
			{
				schema_version: BEAM_TRACE_SCHEMA_VERSION,
				entry_id: "conv-1",
				scale: "128k" as const,
				message_id: "chunk-1",
				chunk_index: 0,
				ingest_batch_index: 0,
				turn_start: 0,
				turn_end: 19,
				source_turn_ids: ["41"],
				content_sha256: "hash",
				content_characters: 7,
				first_timestamp: null,
				last_timestamp: null,
				ingest_status: "completed" as const,
				ingest_latency_ms: 10,
				ingest_warnings: [],
			},
		],
		[
			"chunk-3",
			{
				schema_version: BEAM_TRACE_SCHEMA_VERSION,
				entry_id: "conv-1",
				scale: "128k" as const,
				message_id: "chunk-3",
				chunk_index: 2,
				ingest_batch_index: 0,
				turn_start: 40,
				turn_end: 59,
				source_turn_ids: ["80"],
				content_sha256: "hash",
				content_characters: 7,
				first_timestamp: null,
				last_timestamp: null,
				ingest_status: "completed" as const,
				ingest_latency_ms: 10,
				ingest_warnings: [],
			},
		],
	]);
	const retrieval = buildRetrievalTrace({
		question,
		response: {
			query: question.question,
			sources: ["memory"],
			count: 3,
			warnings: [],
			results: [
				{ id: "chunk-1", content: "Berlin", similarity: 0.91, metadata: {} },
				{ id: "noise", content: "Paris", similarity: 0.82, metadata: {} },
				{ id: "chunk-3", content: "Germany", similarity: 0.75, metadata: {} },
			],
		},
		chunksByMessageId: chunks,
		availableSourceTurnIds: ["41", "80"],
		userId: "beam_conv-1",
		topK: 8,
		latencyMs: 12,
	});

	assert.equal(retrieval.source_recall_at_k, 1);
	assert.equal(retrieval.all_required_sources_retrieved, true);
	assert.equal(retrieval.first_relevant_rank, 1);
	assert.equal(retrieval.mrr, 1);
	assert.equal(retrieval.relevant_hit_precision, 2 / 3);
	assert.deepEqual(retrieval.required_source_turn_ids, ["41", "80"]);
	assert.deepEqual(retrieval.retrieved_source_turn_ids, ["41", "80"]);
	assert.deepEqual(retrieval.missing_source_turn_ids, []);
	assert.equal(retrieval.hit_at_k, 1);
	assert.equal(retrieval.hits[0]?.content, "Berlin");
	assert.deepEqual(retrieval.hits[0]?.matched_source_turn_ids, ["41"]);
	assert.deepEqual(buildAnswerAttribution("See Memory excerpt 3 and [1].", retrieval), {
		cited_hit_ids: ["chunk-1", "chunk-3"],
		cited_relevant_hit_ids: ["chunk-1", "chunk-3"],
		attribution_status: "supported",
	});
});

test("diagnostics classify failures without changing nugget scoring", () => {
	const scores = [1, 0.5, 0];
	const headline = summarizeNuggetScores(scores);
	assert.deepEqual(headline, {
		nugget_mean: 0.5,
		nugget_pass: true,
	});
	const scoredPrediction = {
		status: "completed",
		failure_stage: "none",
		nugget_scores: [...scores],
		nugget_mean: headline.nugget_mean,
		nugget_pass: headline.nugget_pass,
		trace: { retrieval: null, answerer: null, judge: null },
	} as Prediction;
	calculateDiagnosticSummary([scoredPrediction]);
	assert.deepEqual(
		{
			scores: scoredPrediction.nugget_scores,
			mean: scoredPrediction.nugget_mean,
			pass: scoredPrediction.nugget_pass,
		},
		{ scores, mean: 0.5, pass: true },
	);
	assert.equal(
		deriveFailureStage({
			question,
			retrieval: {
				status: "completed",
				query: question.question,
				user_id: "beam_conv-1",
				top_k: 8,
				strategy: "daemon-default",
				latency_ms: 1,
				response_query: question.question,
				response_sources: ["memory"],
				response_count: 0,
				response_warnings: [],
				response_reasoning: null,
				hits: [],
				retrieval_applicable: true,
				required_source_turn_ids: ["41", "80"],
				available_source_turn_ids: ["41", "80"],
				missing_source_turn_ids: [],
				retrieved_source_turn_ids: ["41"],
				missed_source_turn_ids: ["80"],
				dataset_source_coverage: 1,
				source_recall_at_k: 0.5,
				retrievable_source_recall_at_k: 0.5,
				all_required_sources_retrieved: false,
				hit_at_k: 1,
				first_relevant_rank: 1,
				mrr: 1,
				precision_at_k: 0.125,
				relevant_hit_precision: 1,
			},
			nuggetPass: false,
		}),
		"retrieval_partial",
	);
	assert.equal(
		deriveFailureStage({
			question,
			retrieval: {
				status: "completed",
				missing_source_turn_ids: [],
				available_source_turn_ids: ["41", "80"],
				source_recall_at_k: 0.5,
			} as unknown as BeamRetrievalTrace,
			nuggetPass: true,
		}),
		"none",
	);

	const minimal = {
		status: "execution_error",
		failure_stage: "judge_error",
		trace: { retrieval: null, answerer: null, judge: null },
	} as Prediction;
	assert.deepEqual(calculateDiagnosticSummary([minimal]), {
		completed: 0,
		execution_errors: 1,
		failure_stages: { judge_error: 1 },
		retrieval_applicable_questions: 0,
		mean_source_recall_at_k: null,
		mean_retrievable_source_recall_at_k: null,
		mean_dataset_source_coverage: null,
		hit_at_k_rate: null,
		mean_precision_at_k: null,
		mean_reciprocal_rank: null,
		all_required_sources_retrieved_rate: null,
	});
});

test("search client preserves daemon diagnostics and per-hit signals", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				query: "rewritten query",
				sources: ["memory"],
				count: 1,
				warnings: [{ code: "fixture_warning" }],
				reasoning: { strategy: "none" },
				results: [
					{
						id: "chunk-1",
						content: "Berlin",
						similarity: 0.9,
						metadata: { sourceTurnIds: ["41"] },
						signals: { semantic: 0.9, rrf: 0.03 },
					},
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		)) as typeof fetch;
	try {
		const response = await searchMemory("Which city?", 8, "http://fixture", "beam_conv-1");
		assert.equal(response.query, "rewritten query");
		assert.deepEqual(response.warnings, [{ code: "fixture_warning" }]);
		assert.deepEqual(response.reasoning, { strategy: "none" });
		assert.deepEqual(response.results[0]?.signals, { semantic: 0.9, rrf: 0.03 });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("ingest client aggregates batch counts and daemon warnings", async () => {
	const originalFetch = globalThis.fetch;
	let batch = 0;
	globalThis.fetch = (async (_url, init) => {
		batch++;
		const body = JSON.parse(String(init?.body)) as { messages: unknown[] };
		return new Response(
			JSON.stringify({ count: body.messages.length, warnings: [{ code: `batch_${batch}` }] }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;
	try {
		const messages = Array.from({ length: 26 }, (_, index) => ({
			messageId: `message-${index}`,
			userId: "benchmark_user",
			platform: "benchmark",
			botId: "beam",
			timestamp: index,
			content: `message ${index}`,
			createdAt: index,
		}));
		const result = await ingestMessages(messages, "http://fixture", "beam_conv-1");
		assert.equal(result.inserted, 26);
		assert.deepEqual(result.warnings, [{ code: "batch_1" }, { code: "batch_2" }]);
		assert.deepEqual(
			result.batches.map((item) => ({
				index: item.batch_index,
				status: item.status,
				inserted: item.inserted,
			})),
			[
				{ index: 0, status: "completed", inserted: 25 },
				{ index: 1, status: "completed", inserted: 1 },
			],
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("ingest diagnostics identify the failed batch and preserve completed batches", async () => {
	const originalFetch = globalThis.fetch;
	let batch = 0;
	globalThis.fetch = (async (_url, init) => {
		batch++;
		if (batch === 2) return new Response("fixture failure", { status: 503 });
		const body = JSON.parse(String(init?.body)) as { messages: unknown[] };
		return new Response(JSON.stringify({ count: body.messages.length, warnings: [] }), { status: 200 });
	}) as typeof fetch;
	try {
		const messages = Array.from({ length: 26 }, (_, index) => ({
			messageId: `message-${index}`,
			userId: "benchmark_user",
			platform: "benchmark",
			botId: "beam",
			timestamp: index,
			content: `message ${index}`,
			createdAt: index,
		}));
		await assert.rejects(ingestMessages(messages, "http://fixture", "beam_conv-1"), (error: unknown) => {
			assert.ok(error instanceof IngestMessagesError);
			assert.equal(error.result.inserted, 25);
			assert.deepEqual(
				error.result.batches.map((item) => item.status),
				["completed", "execution_error"],
			);
			assert.deepEqual(error.result.batches[1]?.message_ids, ["message-25"]);
			return true;
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});
