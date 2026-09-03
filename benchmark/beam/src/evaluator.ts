/**
 * BEAM Evaluator for the OpenContext memory store.
 *
 * Flow (no agent, no filesystem — pure memory-store HTTP):
 *   1. loadConversation: preserve every source turn as one complete
 *      RawMessage and POST those messages to the
 *      OpenContext daemon (`POST /v1/raw-messages`, embedOnInsert).
 *   2. evaluateQuestion: retrieve relevant chunks (`POST /v1/search`),
 *      then ask the answerer LLM (see opencontext-client.ts) using only
 *      the retrieved excerpts.
 *   3. Judge unchanged (metrics.ts, OpenRouter).
 *
 * Differences from the LongMemEval evaluator:
 *   - Conversations can be enormous (1M avg 842 turns, 10M avg 7,757 turns).
 *     Each source turn remains independently retrievable while core storage
 *     owns any child chunking needed for embedding and retrieval.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sumTokenUsage, unavailableTokenUsage } from "../../run-support";
import { buildAnswerAttribution, buildRetrievalTrace, deriveFailureStage, sha256Text } from "./diagnostics";
import {
	type NuggetJudgeResult,
	evaluateNuggetJudge,
	getJudgeModelIdentity,
	looksLikeAbstention,
	summarizeNuggetScores,
} from "./metrics";
import {
	type BenchRawMessage,
	INGEST_BATCH_SIZE,
	type IngestBatchTrace,
	IngestMessagesError,
	type MemorySearchHit,
	type MemorySearchResponse,
	checkOpencontextHealth,
	generateAnswer,
	getAnswererModelIdentity,
	getOpencontextBaseUrl,
	ingestMessages,
	searchMemory,
} from "./opencontext-client";
import {
	BEAM_TRACE_SCHEMA_VERSION,
	type BeamAnswerTrace,
	type BeamChunkTrace,
	type BeamConversation,
	type BeamJudgeTrace,
	type BeamProbingQuestion,
	type BeamRetrievalTrace,
	type Prediction,
} from "./types";

/** How many retrieved chunks are shown to the answerer. */
const configuredRetrievalLimit = Number.parseInt(process.env.BEAM_TOP_K ?? "8", 10);
export const RETRIEVAL_LIMIT =
	Number.isInteger(configuredRetrievalLimit) && configuredRetrievalLimit > 0
		? Math.min(50, configuredRetrievalLimit)
		: 8;

function parseTimestampMs(ts: string | undefined): number | undefined {
	if (!ts) return undefined;
	try {
		const ms = new Date(ts).getTime();
		return Number.isFinite(ms) ? ms : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Convert a BEAM conversation into raw messages for the memory store.
 */
export function buildConversationMessages(conv: BeamConversation): {
	messages: BenchRawMessage[];
	chunks: BeamChunkTrace[];
} {
	const messages: BenchRawMessage[] = [];
	const chunks: BeamChunkTrace[] = [];
	const now = Date.now();

	for (let turnIndex = 0; turnIndex < conv.chat.length; turnIndex++) {
		const turn = conv.chat[turnIndex];
		if (!turn) continue;
		const messageId = `beam_${conv.entry_id}__turn_${turnIndex}`;
		const sourceTurnIds = turn.source_id ? [turn.source_id] : [];

		messages.push({
			messageId,
			userId: "benchmark_user",
			platform: "benchmark",
			botId: "beam",
			timestamp: parseTimestampMs(turn.timestamp) ?? now,
			content: turn.text,
			createdAt: now,
			metadata: {
				entryId: conv.entry_id,
				conversationId: `beam_${conv.entry_id}`,
				speaker: turn.speaker,
				timestamp: turn.timestamp ?? null,
				sequence: turnIndex,
				scale: conv.scale,
				sourceTurnId: turn.source_id ?? null,
			},
		});
		chunks.push({
			schema_version: BEAM_TRACE_SCHEMA_VERSION,
			entry_id: conv.entry_id,
			scale: conv.scale,
			message_id: messageId,
			chunk_index: turnIndex,
			ingest_batch_index: Math.floor(turnIndex / INGEST_BATCH_SIZE),
			turn_start: turnIndex,
			turn_end: turnIndex,
			source_turn_ids: sourceTurnIds,
			content_sha256: sha256Text(turn.text),
			content_characters: turn.text.length,
			first_timestamp: turn.timestamp ?? null,
			last_timestamp: turn.timestamp ?? null,
			ingest_status: "pending",
			ingest_latency_ms: null,
			ingest_warnings: [],
		});
	}

	return { messages, chunks };
}

export function fingerprintConversation(conv: BeamConversation): string {
	return sha256Text(JSON.stringify({ entry_id: conv.entry_id, scale: conv.scale, chat: conv.chat }));
}

export function fingerprintQuestion(question: BeamProbingQuestion): string {
	return sha256Text(JSON.stringify(question));
}

function applyIngestBatchTraces(chunks: BeamChunkTrace[], batches: IngestBatchTrace[]): void {
	const byMessageId = new Map(
		batches.flatMap((batch) => batch.message_ids.map((messageId) => [messageId, batch] as const)),
	);
	for (const chunk of chunks) {
		const batch = byMessageId.get(chunk.message_id);
		if (!batch) {
			chunk.ingest_status = "not_attempted";
			continue;
		}
		chunk.ingest_status = batch.status;
		chunk.ingest_latency_ms = batch.latency_ms;
		chunk.ingest_warnings = batch.warnings;
		if (batch.error) chunk.error = batch.error;
	}
}

function buildAnswerPrompt(
	conv: BeamConversation,
	question: BeamProbingQuestion,
	hits: MemorySearchHit[],
): string {
	const dateRange =
		conv.chat[0]?.timestamp && conv.chat[conv.chat.length - 1]?.timestamp
			? `${conv.chat[0].timestamp} → ${conv.chat[conv.chat.length - 1].timestamp}`
			: "unknown";

	const excerpts = hits
		.map(
			(h, i) =>
				`--- Memory excerpt ${i + 1} (id=${h.id}, score=${h.similarity.toFixed(3)}) ---\n${h.content}`,
		)
		.join("\n\n");

	return `You are answering a question from the BEAM (Benchmarking EffecTive Agent Memory) benchmark.
A long conversation was previously stored in a memory system. Below are the
memory excerpts the system retrieved for this question. Answer using ONLY
these excerpts.

Conversation: ${conv.entry_id}
Total turns: ${conv.chat.length}
Scale: ${conv.scale}
Date range: ${dateRange}

QUESTION CATEGORY: ${question.category}

QUESTION: ${question.question}

CATEGORY-SPECIFIC GUIDANCE:
${
	question.category === "abstention"
		? `- This is an ABSTENTION question. If the excerpts do not contain the relevant information, REFUSE to answer. Do not guess or hallucinate. A short "I don't know" or "I don't have that information" is the correct answer.`
		: question.category === "knowledge_update"
			? "- This is a KNOWLEDGE-UPDATE question. Look for the LATEST statement on the topic. If earlier turns contradict a later turn, the later turn wins. If the topic was discussed but no final answer was ever confirmed, say so."
			: question.category === "contradiction_resolution"
				? "- This is a CONTRADICTION-RESOLUTION question. The user stated something earlier and something different later. Identify both and report the later / currently-active state."
				: question.category === "multi_session_reasoning"
					? "- This is a MULTI-SESSION question. The answer requires combining information from at least 2 distinct points in the conversation. Cite both."
					: question.category === "preference_following"
						? `- This is a PREFERENCE question. If the user expressed multiple preferences over time, use the latest one. If no relevant preference exists in the excerpts, say you don't know.`
						: question.category === "temporal_reasoning"
							? "- This is a TEMPORAL question. Use the timestamps in the excerpts as the authoritative dates. Calculate durations from those, not from today."
							: question.category === "event_ordering"
								? "- This is an EVENT-ORDERING question. Use excerpt timestamps to determine which event came first. State the order explicitly."
								: question.category === "instruction_following"
									? "- This is an INSTRUCTION-FOLLOWING question. The user gave a rule at some point; verify the rule is still active and apply it."
									: question.category === "summarization"
										? "- This is a SUMMARIZATION question. Compress the relevant excerpts into a concise answer."
										: "- This is an INFORMATION-EXTRACTION question. Pull the specific fact from the excerpts."
}

RETRIEVED MEMORY EXCERPTS (${hits.length}):
${excerpts || "(the memory system returned no relevant excerpts)"}

GENERAL INSTRUCTIONS:
1. Answer concisely, citing the excerpt number(s) you used.
2. If the excerpts do not contain the answer, say "I don't know" — do not guess.`;
}

export { checkOpencontextHealth, getOpencontextBaseUrl };

/** Per-conversation user id so retrieval only sees this conversation's chunks. */
function beamUserId(conv: BeamConversation): string {
	return `beam_v13_${conv.entry_id}`;
}

/** Resolve the checkpoint namespace without touching any existing run. */
export function getBeamCheckpointDir(): string {
	const configured = process.env.BEAM_CHECKPOINT_DIR?.trim();
	return configured ? resolve(configured) : join(import.meta.dirname, "..", "checkpoints", "beam");
}

export class BeamEvaluator {
	private baseUrl: string;
	private quickLimit?: number;
	private checkpointDir: string;
	private resume: boolean;
	private chunkTraces = new Map<string, BeamChunkTrace>();
	private conversationFingerprints = new Map<string, string>();

	constructor(baseUrl?: string, quickLimit?: number, resume = true) {
		this.baseUrl = baseUrl ?? getOpencontextBaseUrl();
		this.quickLimit = quickLimit;
		this.resume = resume;
		this.checkpointDir = getBeamCheckpointDir();
	}

	private getCheckpointPath(questionId: string): string {
		return join(this.checkpointDir, `${questionId}.json`);
	}

	private async loadCheckpoint(questionId: string): Promise<Prediction | null> {
		if (!this.resume) return null;
		try {
			const data = await readFile(this.getCheckpointPath(questionId), "utf-8");
			return JSON.parse(data) as Prediction;
		} catch {
			return null;
		}
	}

	private async saveCheckpoint(questionId: string, prediction: Prediction): Promise<void> {
		try {
			await mkdir(this.checkpointDir, { recursive: true });
			await writeFile(this.getCheckpointPath(questionId), JSON.stringify(prediction, null, 2), "utf-8");
		} catch (error) {
			console.error(`Failed to save checkpoint: ${error}`);
		}
	}

	getChunkTraces(): BeamChunkTrace[] {
		return [...this.chunkTraces.values()];
	}

	createExecutionErrorPrediction(
		conv: BeamConversation,
		question: BeamProbingQuestion,
		error: unknown,
		stage: "ingest" | "retrieval" | "answerer" | "judge" | "provider",
		attempt = 1,
		trace: { retrieval?: BeamRetrievalTrace | null; answerer?: BeamAnswerTrace | null } = {},
	): Prediction {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			trace_schema_version: BEAM_TRACE_SCHEMA_VERSION,
			entry_id: conv.entry_id,
			conversation_sha256: this.conversationFingerprints.get(conv.entry_id) ?? fingerprintConversation(conv),
			question_sha256: fingerprintQuestion(question),
			status: "execution_error",
			attempt,
			execution_error: { stage, message: errorMessage },
			token_usage: unavailableTokenUsage(),
			answerer_model: getAnswererModelIdentity(),
			judge_model: getJudgeModelIdentity(),
			question_id: question.question_id,
			question: question.question,
			gold_answer: question.gold_answer ?? null,
			source: question.source,
			response: `Error: ${errorMessage}`,
			prediction: `Error: ${errorMessage}`,
			atoms: question.atoms,
			category: question.category,
			scale: conv.scale,
			nugget_scores: question.atoms.map(() => 0),
			nugget_mean: 0,
			nugget_pass: false,
			judge_reasoning: `agent failure: ${errorMessage}`,
			trace: {
				retrieval: trace.retrieval ?? null,
				answerer: trace.answerer ?? null,
				judge: null,
			},
			failure_stage: deriveFailureStage({
				question,
				retrieval: trace.retrieval ?? null,
				nuggetPass: false,
				executionStage: stage,
			}),
			abstained: false,
		};
	}

	/**
	 * Ingest a BEAM conversation into the OpenContext memory store.
	 * Returns the number of ingested chunk messages.
	 */
	async loadConversation(conv: BeamConversation): Promise<number> {
		const { messages, chunks } = buildConversationMessages(conv);
		this.conversationFingerprints.set(conv.entry_id, fingerprintConversation(conv));
		for (const chunk of chunks) this.chunkTraces.set(chunk.message_id, chunk);
		const startedAt = performance.now();
		try {
			const ingestResult = await ingestMessages(messages, this.baseUrl, beamUserId(conv));
			applyIngestBatchTraces(chunks, ingestResult.batches);
			console.log(
				`[BEAM] Ingested ${ingestResult.inserted} chunk messages for ${conv.entry_id} → ${this.baseUrl}`,
			);
			return messages.length;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof IngestMessagesError) applyIngestBatchTraces(chunks, error.result.batches);
			else {
				const latencyMs = Math.round(performance.now() - startedAt);
				for (const chunk of chunks) {
					chunk.ingest_status = "execution_error";
					chunk.ingest_latency_ms = latencyMs;
					chunk.error = message;
				}
			}
			throw error;
		}
	}

	/**
	 * Evaluate one BEAM question against the ingested conversation.
	 */
	async evaluateQuestion(
		conv: BeamConversation,
		question: BeamProbingQuestion,
		_chunkCount: number,
	): Promise<Prediction> {
		const answererModel = getAnswererModelIdentity();
		const judgeModel = getJudgeModelIdentity();
		const conversationSha256 =
			this.conversationFingerprints.get(conv.entry_id) ?? fingerprintConversation(conv);
		const questionSha256 = fingerprintQuestion(question);

		// Reuse only completed results produced by the currently configured models.
		const checkpoint = await this.loadCheckpoint(question.question_id);
		const checkpointMatchesContext =
			checkpoint?.trace_schema_version === BEAM_TRACE_SCHEMA_VERSION &&
			checkpoint.entry_id === conv.entry_id &&
			checkpoint.conversation_sha256 === conversationSha256 &&
			checkpoint.question_sha256 === questionSha256 &&
			checkpoint.answerer_model === answererModel &&
			checkpoint.judge_model === judgeModel;
		if (
			checkpoint?.response &&
			checkpointMatchesContext &&
			checkpoint.status === "completed" &&
			!checkpoint.response.startsWith("Error:") &&
			checkpoint.nugget_scores.length === question.atoms.length &&
			!checkpoint.judge_reasoning.startsWith("judge failure")
		) {
			console.log(`[BEAM] Resuming from checkpoint for ${question.question_id}`);
			return checkpoint;
		}
		if (
			checkpoint &&
			(checkpoint.answerer_model !== answererModel || checkpoint.judge_model !== judgeModel)
		) {
			console.log(`[BEAM] Ignoring checkpoint for ${question.question_id}: model configuration changed`);
		} else if (checkpoint && checkpoint.trace_schema_version !== BEAM_TRACE_SCHEMA_VERSION) {
			console.log(`[BEAM] Ignoring legacy checkpoint for ${question.question_id}: diagnostic trace missing`);
		} else if (
			checkpoint &&
			(checkpoint.entry_id !== conv.entry_id ||
				checkpoint.conversation_sha256 !== conversationSha256 ||
				checkpoint.question_sha256 !== questionSha256)
		) {
			console.log(`[BEAM] Ignoring checkpoint for ${question.question_id}: conversation data changed`);
		} else if (checkpoint?.status === "execution_error") {
			console.log(`[BEAM] Retrying execution error for ${question.question_id}`);
		}

		const attempt =
			checkpointMatchesContext && checkpoint.status === "execution_error" ? (checkpoint.attempt ?? 0) + 1 : 1;
		let answerUsage = unavailableTokenUsage();
		let judgeUsage = unavailableTokenUsage();
		let retrievalTrace: BeamRetrievalTrace | null = null;
		let answerTrace: BeamAnswerTrace | null = null;
		let executionStage: "retrieval" | "answerer" | "judge" = "retrieval";
		try {
			const searchStartedAt = performance.now();
			let searchResponse: MemorySearchResponse;
			try {
				searchResponse = await searchMemory(
					question.question,
					RETRIEVAL_LIMIT,
					this.baseUrl,
					beamUserId(conv),
					{ includeRetrievalDiagnostics: true },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const availableSet = new Set(
					conv.chat.map((turn) => turn.source_id).filter((id): id is string => typeof id === "string"),
				);
				const requiredIds = [...new Set(question.source.source_chat_ids)];
				const availableIds = requiredIds.filter((id) => availableSet.has(id));
				const missingIds = requiredIds.filter((id) => !availableSet.has(id));
				retrievalTrace = {
					status: "execution_error",
					query: question.question,
					user_id: beamUserId(conv),
					top_k: RETRIEVAL_LIMIT,
					candidate_k: null,
					strategy: "daemon-default",
					merge_strategy: null,
					threshold: null,
					backend: null,
					semantic_degraded_reason: null,
					candidate_counts: null,
					latency_ms: Math.round(performance.now() - searchStartedAt),
					response_query: question.question,
					response_sources: [],
					response_count: 0,
					response_warnings: [],
					response_reasoning: null,
					premerge_diagnostics_available: false,
					candidate_channels: { semantic: [], lexical: [], hybrid: [], entity: [] },
					fused_before_rerank: [],
					reranker: null,
					semantic_source_recall_at_candidate_k: null,
					lexical_source_recall_at_candidate_k: null,
					hybrid_source_recall_at_candidate_k: null,
					hits: [],
					retrieval_applicable: question.source.source_chat_ids.length > 0,
					required_source_turn_ids: requiredIds,
					available_source_turn_ids: availableIds,
					missing_source_turn_ids: missingIds,
					retrieved_source_turn_ids: [],
					missed_source_turn_ids: requiredIds,
					dataset_source_coverage: requiredIds.length > 0 ? availableIds.length / requiredIds.length : null,
					source_recall_at_k: null,
					retrievable_source_recall_at_k: null,
					all_required_sources_retrieved: null,
					hit_at_k: null,
					first_relevant_rank: null,
					mrr: null,
					precision_at_k: null,
					relevant_hit_precision: null,
					error: message,
				};
				throw error;
			}
			retrievalTrace = buildRetrievalTrace({
				question,
				response: searchResponse,
				chunksByMessageId: this.chunkTraces,
				availableSourceTurnIds: conv.chat
					.map((turn) => turn.source_id)
					.filter((id): id is string => typeof id === "string"),
				userId: beamUserId(conv),
				topK: RETRIEVAL_LIMIT,
				latencyMs: Math.round(performance.now() - searchStartedAt),
			});
			const hits = searchResponse.results;
			const contextCharacters = hits.reduce((sum, hit) => sum + hit.content.length, 0);
			const prompt = buildAnswerPrompt(conv, question, hits);
			executionStage = "answerer";
			const answerStartedAt = performance.now();
			let response: string;
			try {
				const answerResult = await generateAnswer(prompt);
				answerUsage = answerResult.token_usage;
				response = answerResult.text;
				if (!response.trim()) throw new Error("answerer returned an empty response");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				answerTrace = {
					model: answererModel,
					status: "execution_error",
					attempt: 1,
					latency_ms: Math.round(performance.now() - answerStartedAt),
					prompt_version: "beam-answer-v1",
					prompt_sha256: sha256Text(prompt),
					prompt_characters: prompt.length,
					system_prompt: null,
					prompt,
					token_usage: answerUsage,
					included_hit_ids: hits.map((hit) => hit.id),
					included_context_characters: contextCharacters,
					cited_hit_ids: [],
					cited_relevant_hit_ids: [],
					attribution_status: retrievalTrace.retrieval_applicable ? "uncited" : "not_applicable",
					error: message,
				};
				throw error;
			}
			const attribution = buildAnswerAttribution(response, retrievalTrace);
			answerTrace = {
				model: answererModel,
				status: "completed",
				attempt: 1,
				latency_ms: Math.round(performance.now() - answerStartedAt),
				prompt_version: "beam-answer-v1",
				prompt_sha256: sha256Text(prompt),
				prompt_characters: prompt.length,
				system_prompt: null,
				prompt,
				token_usage: answerUsage,
				included_hit_ids: hits.map((hit) => hit.id),
				included_context_characters: contextCharacters,
				...attribution,
			};

			const abstained = looksLikeAbstention(response);

			executionStage = "judge";
			const judgeResult: NuggetJudgeResult = await evaluateNuggetJudge(
				question.question,
				question.category,
				question.atoms,
				response,
			);
			judgeUsage = judgeResult.token_usage;
			const judgeTrace: BeamJudgeTrace = {
				model: judgeModel,
				status: judgeResult.status,
				attempt: judgeResult.attempt,
				latency_ms: judgeResult.latency_ms,
				prompt_version: judgeResult.prompt_version,
				prompt_sha256: judgeResult.prompt_sha256,
				prompt_characters: judgeResult.prompt_characters,
				system_prompt: judgeResult.system_prompt,
				prompt: judgeResult.prompt,
				token_usage: judgeResult.token_usage,
				raw_response: judgeResult.raw_response,
				parse_status: judgeResult.parse_status,
				...(judgeResult.error ? { error: judgeResult.error } : {}),
			};

			const { nugget_mean, nugget_pass } = summarizeNuggetScores(judgeResult.scores);
			const executionError = judgeResult.status === "execution_error";

			const pred: Prediction = {
				trace_schema_version: BEAM_TRACE_SCHEMA_VERSION,
				entry_id: conv.entry_id,
				conversation_sha256: conversationSha256,
				question_sha256: questionSha256,
				status: executionError ? "execution_error" : "completed",
				attempt,
				...(executionError
					? { execution_error: { stage: "judge", message: judgeResult.error ?? "judge failure" } }
					: {}),
				token_usage: sumTokenUsage([answerUsage, judgeUsage]),
				answerer_model: answererModel,
				judge_model: judgeModel,
				question_id: question.question_id,
				question: question.question,
				gold_answer: question.gold_answer ?? null,
				source: question.source,
				response,
				prediction: response,
				atoms: question.atoms,
				category: question.category,
				scale: conv.scale,
				nugget_scores: judgeResult.scores,
				nugget_mean,
				nugget_pass,
				judge_reasoning: judgeResult.reasoning,
				trace: { retrieval: retrievalTrace, answerer: answerTrace, judge: judgeTrace },
				failure_stage: deriveFailureStage({
					question,
					retrieval: retrievalTrace,
					nuggetPass: nugget_pass,
					...(executionError ? { executionStage: "judge" as const } : {}),
				}),
				abstained,
			};

			const status = nugget_pass ? "✓" : "✗";
			console.log(
				`[BEAM] ${status} ${question.category} Q="${question.question.substring(0, 50)}..." mean=${nugget_mean.toFixed(2)}`,
			);

			await this.saveCheckpoint(question.question_id, pred);
			return pred;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`Error evaluating question: ${errorMessage}`);
			const pred = this.createExecutionErrorPrediction(conv, question, error, executionStage, attempt, {
				retrieval: retrievalTrace,
				answerer: answerTrace,
			});
			pred.token_usage = sumTokenUsage([answerUsage, judgeUsage]);

			await this.saveCheckpoint(question.question_id, pred);
			return pred;
		}
	}
}
