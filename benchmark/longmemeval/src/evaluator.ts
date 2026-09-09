/**
 * LongMemEval Evaluator for the OpenContext memory store.
 *
 * Flow (no agent, no filesystem — pure memory-store HTTP):
 *   1. loadEntry: convert the haystack sessions into raw messages and POST
 *      them to the OpenContext daemon (`POST /v1/raw-messages`,
 *      embedOnInsert).
 *   2. evaluateQuestion: retrieve relevant sessions (`POST /v1/search`),
 *      then ask the answerer LLM (see opencontext-client.ts) using only
 *      the retrieved excerpts.
 *   3. Judge with the existing metrics.ts model and prompt (OpenRouter).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sumTokenUsage, unavailableTokenUsage } from "../../run-support";
import { buildRetrievalErrorTrace, buildRetrievalTrace, deriveFailureStage, sha256Text } from "./diagnostics";
import { calculateMetrics, evaluateLLMJudge, getJudgeModelIdentity } from "./metrics";
import {
	AnswererGenerationError,
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
	LONGMEMEVAL_TRACE_SCHEMA_VERSION,
	type LongMemEvalAnswerTrace,
	type LongMemEvalEntry,
	type LongMemEvalJudgeTrace,
	type LongMemEvalRetrievalTrace,
	type LongMemEvalSessionTrace,
	type Prediction,
} from "./types";

/** How many retrieved sessions are shown to the answerer. */
const configuredRetrievalLimit = Number.parseInt(process.env.LONGMEMEVAL_TOP_K ?? "8", 10);
export const RETRIEVAL_LIMIT =
	Number.isInteger(configuredRetrievalLimit) && configuredRetrievalLimit > 0
		? Math.min(50, configuredRetrievalLimit)
		: 8;

/**
 * Parse timestamp string to Unix ms.
 */
function parseTimestamp(ts: string): number | undefined {
	if (!ts) return undefined;
	try {
		const date = new Date(ts);
		if (!Number.isNaN(date.getTime())) {
			return date.getTime();
		}
		const parsed = Date.parse(ts);
		return Number.isNaN(parsed) ? undefined : parsed;
	} catch {
		return undefined;
	}
}

/**
 * Convert LongMemEval entry haystack sessions into raw messages for the
 * memory store. One message per session; messageId is deterministic
 * (question_id + session_id) so re-ingestion stays idempotent.
 */
export function buildSessionMessages(entry: LongMemEvalEntry): {
	messages: BenchRawMessage[];
	sessions: LongMemEvalSessionTrace[];
} {
	const messages: BenchRawMessage[] = [];
	const sessions: LongMemEvalSessionTrace[] = [];

	const { haystack_sessions, haystack_session_ids, haystack_dates } = entry;
	const now = Date.now();
	const sessionIdOccurrences = new Map<string, number>();
	for (const sessionId of haystack_session_ids) {
		sessionIdOccurrences.set(sessionId, (sessionIdOccurrences.get(sessionId) ?? 0) + 1);
	}

	for (let i = 0; i < Math.min(haystack_sessions.length, haystack_session_ids.length); i++) {
		const session = haystack_sessions[i];
		const sessionId = haystack_session_ids[i];
		const date = haystack_dates[i] ?? "";

		// Build session content
		const parts: string[] = [];
		parts.push(`# Conversation Session ${sessionId}`);
		if (date) {
			parts.push(`# Date: ${date}`);
		}
		parts.push("");

		for (const turn of session) {
			const role = turn.role === "user" ? "User" : "Assistant";
			parts.push(`${role}: ${turn.content}`);
		}

		// The dataset occasionally repeats a session id inside one haystack.
		// Keep the normal stable id, but make duplicate occurrences independently
		// addressable so their chunks cannot be merged by the daemon.
		const messageId =
			(sessionIdOccurrences.get(sessionId) ?? 0) > 1
				? `lme_${entry.question_id}__${sessionId}__${i}`
				: `lme_${entry.question_id}__${sessionId}`;
		const content = parts.join("\n");
		messages.push({
			messageId,
			userId: "benchmark_user",
			platform: "benchmark",
			botId: "longmemeval",
			timestamp: parseTimestamp(date) ?? now,
			content,
			createdAt: now,
			metadata: {
				questionId: entry.question_id,
				sessionId,
				contentType: "session",
				sessionDate: date || null,
				turnCount: session.length,
			},
		});
		sessions.push({
			schema_version: LONGMEMEVAL_TRACE_SCHEMA_VERSION,
			question_id: entry.question_id,
			message_id: messageId,
			session_id: sessionId,
			session_index: i,
			ingest_batch_index: Math.floor(i / INGEST_BATCH_SIZE),
			session_date: date || null,
			turn_count: session.length,
			content_sha256: sha256Text(content),
			content_characters: content.length,
			ingest_status: "pending",
			ingest_latency_ms: null,
			ingest_warnings: [],
		});
	}

	return { messages, sessions };
}

export function fingerprintEntry(entry: LongMemEvalEntry): string {
	return sha256Text(JSON.stringify(entry));
}

export function fingerprintQuestion(entry: LongMemEvalEntry): string {
	return sha256Text(
		JSON.stringify({
			question_id: entry.question_id,
			question_type: entry.question_type,
			question: entry.question,
			question_date: entry.question_date,
			answer: entry.answer,
			answer_session_ids: entry.answer_session_ids,
		}),
	);
}

function applyIngestBatchTraces(sessions: LongMemEvalSessionTrace[], batches: IngestBatchTrace[]): void {
	const byMessageId = new Map(
		batches.flatMap((batch) => batch.message_ids.map((messageId) => [messageId, batch] as const)),
	);
	for (const session of sessions) {
		const batch = byMessageId.get(session.message_id);
		if (!batch) {
			session.ingest_status = "not_attempted";
			continue;
		}
		session.ingest_status = batch.status;
		session.ingest_latency_ms = batch.latency_ms;
		session.ingest_warnings = batch.warnings;
		if (batch.error) session.error = batch.error;
	}
}

function buildAnswerPrompt(entry: LongMemEvalEntry, hits: MemorySearchHit[]): string {
	// Build date context for temporal reasoning
	const sortedDates = [...entry.haystack_dates].sort();
	const dateRange =
		sortedDates.length > 0
			? `${Math.min(...sortedDates.map((d) => new Date(d).getTime())) > 0 ? sortedDates[0] : "unknown"} to ${sortedDates[sortedDates.length - 1]}`
			: "unknown";

	const excerpts = hits
		.map(
			(h, i) =>
				`--- Memory excerpt ${i + 1} (id=${h.id}, score=${h.similarity.toFixed(3)}) ---\n${h.content}`,
		)
		.join("\n\n");

	return `Please answer the following question based ONLY on the memory excerpts retrieved below.

Question: ${entry.question}
${entry.question_date ? `(This question was asked on: ${entry.question_date})` : ""}

RETRIEVED MEMORY EXCERPTS (${hits.length}):
${excerpts || "(the memory system returned no relevant excerpts)"}

IMPORTANT INSTRUCTIONS:
1. Answer using ONLY the retrieved memory excerpts above — do not use outside knowledge
2. The excerpts contain conversation history between two people
3. Pay attention to specific facts mentioned - the question is asking about the other person's life/experiences
4. CRITICAL: Distinguish between PLANNED/FUTURE actions ("I will...", "I'm going to...", "I plan to...") and COMPLETED/PAST actions ("I did...", "I have...", "I finished..."). A plan is NOT the same as an actual event. If someone SAYS they will do something but there's no later confirmation they actually did it, the answer should reflect that the action was NOT completed.

${
	entry.question_type === "temporal-reasoning"
		? `\
5. For temporal questions:
   - ALWAYS find the EXACT date/time from each relevant excerpt
   - Find when the event happened AND when the reference point is (e.g., "when did I go on my 10th jog outdoors?")
   - Calculate the EXACT difference in days/weeks/months
   - If question asks "how many weeks had passed since X when Y", find the date of X and the date of Y, then subtract
   - Use the session date shown at the top of each excerpt as the authoritative date
   - Verify your calculation before answering
   - IMPORTANT: When the question asks about something like "when did X happen", check if the excerpt contains actual completion of X, not just planning to do X`
		: `\
5. The conversation memories span from ${dateRange}. When answering temporal questions (e.g., "how many weeks ago", "how many months ago"), use the DATE shown at the top of each excerpt (the session date), NOT today's date. Calculate the time difference from THAT session date.`
}

${
	entry.question_type === "multi-session"
		? `\
6. For counting questions across multiple sessions:
   - Go through EVERY retrieved excerpt systematically - do not skip any, even if you think you found the answer early
   - Keep a running list of every item you find with the source excerpt
   - If the question asks "how many X", list each X you found with the excerpt it came from
   - Make sure you don't count the same item twice
   - Add up the total count carefully
   - Note: only ${hits.length} excerpts were retrieved, so the answer may rely on partial evidence`
		: ""
}

${
	entry.question_type === "knowledge-update"
		? `\
6. For knowledge-update questions:
   - Look for information that has been explicitly stated as completed or confirmed
   - If you only find someone planning to do something ("I will...", "I'm going to...") but no confirmation they actually did it, the information should be considered "not updated" or "not available"
   - If the information is not explicitly mentioned in any excerpt, respond: "I don't know" or "The information is not available in my memory." Do NOT guess or infer.`
		: ""
}

${
	entry.question_type === "single-session-preference"
		? `\
6. For preference questions, if no relevant preference information exists in the excerpts, respond: "I don't know" or "I don't have information about your preference for this topic."`
		: ""
}

7. Provide a specific answer based on the evidence in the excerpts
8. If you cannot find the answer, say you don't know rather than guessing`;
}

export { checkOpencontextHealth, getOpencontextBaseUrl };

/** Per-question user id so retrieval cannot cross-contaminate dataset entries. */
function longMemEvalUserId(entry: LongMemEvalEntry): string {
	return `longmemeval_v1_${entry.question_id}`;
}

export function getLongMemEvalCheckpointDir(): string {
	const configured = process.env.LONGMEMEVAL_CHECKPOINT_DIR?.trim();
	return configured ? resolve(configured) : join(import.meta.dirname, "..", "checkpoints", "longmemeval");
}

/**
 * Evaluator for LongMemEval benchmark using the OpenContext memory store.
 */
export class LongMemEvalEvaluator {
	private baseUrl: string;
	private checkpointDir: string;
	private resume: boolean;
	private sessionTraces = new Map<string, LongMemEvalSessionTrace>();
	private entryFingerprints = new Map<string, string>();

	constructor(baseUrl?: string, _quickLimit?: number, resume = true) {
		this.baseUrl = baseUrl ?? getOpencontextBaseUrl();
		this.resume = resume;
		this.checkpointDir = getLongMemEvalCheckpointDir();
	}

	/**
	 * Get checkpoint file path for a question.
	 */
	private getCheckpointPath(questionId: string): string {
		return join(this.checkpointDir, `${questionId}.json`);
	}

	/**
	 * Load checkpoint for a question if it exists.
	 */
	private async loadCheckpoint(questionId: string): Promise<Prediction | null> {
		if (!this.resume) return null;
		try {
			const path = this.getCheckpointPath(questionId);
			const data = await readFile(path, "utf-8");
			return JSON.parse(data) as Prediction;
		} catch {
			return null;
		}
	}

	/**
	 * Save checkpoint after evaluation.
	 */
	private async saveCheckpoint(questionId: string, prediction: Prediction): Promise<void> {
		try {
			await mkdir(this.checkpointDir, { recursive: true });
			const path = this.getCheckpointPath(questionId);
			await writeFile(path, JSON.stringify(prediction, null, 2), "utf-8");
		} catch (error) {
			process.stderr.write(`Failed to save checkpoint: ${error}\n`);
		}
	}

	getSessionTraces(): LongMemEvalSessionTrace[] {
		return [...this.sessionTraces.values()];
	}

	private checkpointMatchesEntry(checkpoint: Prediction | null, entry: LongMemEvalEntry): boolean {
		const entrySha256 = this.entryFingerprints.get(entry.question_id) ?? fingerprintEntry(entry);
		return (
			checkpoint?.trace_schema_version === LONGMEMEVAL_TRACE_SCHEMA_VERSION &&
			checkpoint.entry_sha256 === entrySha256 &&
			checkpoint.question_sha256 === fingerprintQuestion(entry) &&
			checkpoint.answerer_model === getAnswererModelIdentity() &&
			checkpoint.judge_model === getJudgeModelIdentity()
		);
	}

	/**
	 * Reuse a completed checkpoint before attempting ingestion on a resumed run.
	 *
	 * A completed checkpoint can only have been written after the original
	 * loadEntry call succeeded, so its raw-session mapping is restored locally
	 * for the final evidence artifact without replaying an expensive idempotent
	 * POST to the daemon. Failed and stale checkpoints deliberately return null:
	 * those entries must still go through the daemon again.
	 */
	async reuseCompletedCheckpoint(entry: LongMemEvalEntry): Promise<Prediction | null> {
		if (!this.resume) return null;
		this.entryFingerprints.set(entry.question_id, fingerprintEntry(entry));
		const checkpoint = await this.loadCheckpoint(entry.question_id);
		if (checkpoint?.status !== "completed" || !this.checkpointMatchesEntry(checkpoint, entry)) return null;

		const { sessions } = buildSessionMessages(entry);
		for (const session of sessions) {
			session.ingest_status = "completed";
			session.ingest_warnings = [
				"Restored from a context-matched completed checkpoint; original ingest latency was not persisted.",
			];
			this.sessionTraces.set(session.message_id, session);
		}
		return checkpoint;
	}

	createExecutionErrorPrediction(
		entry: LongMemEvalEntry,
		error: unknown,
		stage: "ingest" | "retrieval" | "answerer" | "judge" | "provider",
		attempt = 1,
		trace: {
			retrieval?: LongMemEvalRetrievalTrace | null;
			answerer?: LongMemEvalAnswerTrace | null;
			judge?: LongMemEvalJudgeTrace | null;
		} = {},
	): Prediction {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const answer = String(entry.answer);
		return {
			trace_schema_version: LONGMEMEVAL_TRACE_SCHEMA_VERSION,
			entry_sha256: this.entryFingerprints.get(entry.question_id) ?? fingerprintEntry(entry),
			question_sha256: fingerprintQuestion(entry),
			status: "execution_error",
			attempt,
			answerer_model: getAnswererModelIdentity(),
			judge_model: getJudgeModelIdentity(),
			execution_error: { stage, message: errorMessage },
			token_usage: unavailableTokenUsage(),
			question_id: entry.question_id,
			question: entry.question,
			question_date: entry.question_date,
			answer,
			response: `Error: ${errorMessage}`,
			prediction: `Error: ${errorMessage}`,
			ground_truth: answer,
			question_type: entry.question_type,
			llm_score: 0,
			correct: false,
			f1_score: 0,
			bleu_score: 0,
			bleu1: 0,
			bleu2: 0,
			bleu3: 0,
			bleu4: 0,
			evidence_session_ids: entry.answer_session_ids,
			trace: {
				retrieval: trace.retrieval ?? null,
				answerer: trace.answerer ?? null,
				judge: trace.judge ?? null,
			},
			failure_stage: deriveFailureStage({
				entry,
				retrieval: trace.retrieval ?? null,
				correct: false,
				executionStage: stage,
			}),
		};
	}

	/**
	 * Ingest a LongMemEval entry into the OpenContext memory store.
	 */
	async loadEntry(entry: LongMemEvalEntry): Promise<number> {
		const { messages, sessions } = buildSessionMessages(entry);
		this.entryFingerprints.set(entry.question_id, fingerprintEntry(entry));
		for (const session of sessions) this.sessionTraces.set(session.message_id, session);
		const startedAt = performance.now();
		try {
			const result = await ingestMessages(messages, this.baseUrl, longMemEvalUserId(entry));
			applyIngestBatchTraces(sessions, result.batches);
			process.stdout.write(
				`[LongMemEval] Ingested ${result.inserted} raw sessions for ${entry.question_id} → ${this.baseUrl}\n`,
			);
			return messages.length;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof IngestMessagesError) applyIngestBatchTraces(sessions, error.result.batches);
			else {
				const latencyMs = Math.round(performance.now() - startedAt);
				for (const session of sessions) {
					session.ingest_status = "execution_error";
					session.ingest_latency_ms = latencyMs;
					session.error = message;
				}
			}
			throw error;
		}
	}

	/**
	 * Evaluate a single question.
	 */
	async evaluateQuestion(entry: LongMemEvalEntry): Promise<Prediction> {
		const answererModel = getAnswererModelIdentity();
		const judgeModel = getJudgeModelIdentity();
		const entrySha256 = this.entryFingerprints.get(entry.question_id) ?? fingerprintEntry(entry);
		const questionSha256 = fingerprintQuestion(entry);
		const checkpoint = await this.loadCheckpoint(entry.question_id);
		const checkpointMatchesContext = this.checkpointMatchesEntry(checkpoint, entry);
		if (checkpoint?.status === "completed" && checkpointMatchesContext) {
			return checkpoint;
		}
		if (checkpoint) {
			const message =
				checkpoint.status === "execution_error"
					? `Retrying ${entry.question_id}: execution error`
					: `Re-running ${entry.question_id}: trace, data, or model mismatch`;
			process.stdout.write(`[LongMemEval] ${message}\n`);
		}
		const attempt =
			checkpoint !== null && checkpointMatchesContext && checkpoint.status === "execution_error"
				? (checkpoint.attempt ?? 0) + 1
				: 1;

		const answerStr = String(entry.answer);
		let answerUsage = unavailableTokenUsage();
		let judgeUsage = unavailableTokenUsage();
		let retrievalTrace: LongMemEvalRetrievalTrace | null = null;
		let answerTrace: LongMemEvalAnswerTrace | null = null;
		let judgeTrace: LongMemEvalJudgeTrace | null = null;
		let executionStage: "retrieval" | "answerer" | "judge" = "retrieval";

		try {
			const searchStartedAt = performance.now();
			let searchResponse: MemorySearchResponse;
			try {
				searchResponse = await searchMemory(
					entry.question,
					RETRIEVAL_LIMIT,
					this.baseUrl,
					longMemEvalUserId(entry),
					{ includeRetrievalDiagnostics: true },
				);
			} catch (error) {
				retrievalTrace = buildRetrievalErrorTrace({
					entry,
					userId: longMemEvalUserId(entry),
					topK: RETRIEVAL_LIMIT,
					latencyMs: Math.round(performance.now() - searchStartedAt),
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
			const sessionsByMessageId = new Map(
				this.getSessionTraces()
					.filter((session) => session.question_id === entry.question_id)
					.map((session) => [session.message_id, session] as const),
			);
			retrievalTrace = buildRetrievalTrace({
				entry,
				response: searchResponse,
				sessionsByMessageId,
				userId: longMemEvalUserId(entry),
				topK: RETRIEVAL_LIMIT,
				latencyMs: Math.round(performance.now() - searchStartedAt),
			});

			const hits = searchResponse.results;
			const prompt = buildAnswerPrompt(entry, hits);
			const contextCharacters = hits.reduce((sum, hit) => sum + hit.content.length, 0);
			executionStage = "answerer";
			const answerStartedAt = performance.now();
			let response: string;
			let answerAttempt = 1;
			try {
				const answerResult = await generateAnswer(prompt);
				answerUsage = answerResult.token_usage;
				response = answerResult.text;
				answerAttempt = answerResult.attempt;
				if (!response.trim()) throw new Error("Answerer returned an empty response");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				answerTrace = {
					model: answererModel,
					status: "execution_error",
					attempt: error instanceof AnswererGenerationError ? error.attempts : 1,
					latency_ms: Math.round(performance.now() - answerStartedAt),
					prompt_version: "longmemeval-answer-v1",
					prompt_sha256: sha256Text(prompt),
					prompt_characters: prompt.length,
					system_prompt: null,
					prompt,
					token_usage: answerUsage,
					included_hit_ids: hits.map((hit) => hit.id),
					included_context_characters: contextCharacters,
					error: message,
				};
				throw error;
			}
			answerTrace = {
				model: answererModel,
				status: "completed",
				attempt: answerAttempt,
				latency_ms: Math.round(performance.now() - answerStartedAt),
				prompt_version: "longmemeval-answer-v1",
				prompt_sha256: sha256Text(prompt),
				prompt_characters: prompt.length,
				system_prompt: null,
				prompt,
				token_usage: answerUsage,
				included_hit_ids: hits.map((hit) => hit.id),
				included_context_characters: contextCharacters,
			};

			executionStage = "judge";
			const judgeResult = await evaluateLLMJudge(entry.question, answerStr, response);
			judgeUsage = judgeResult.token_usage;
			judgeTrace = {
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
			const executionError = judgeResult.status === "execution_error";
			const isCorrect = !executionError && judgeResult.score === 1;

			const metrics = calculateMetrics(response, answerStr);

			const pred: Prediction = {
				trace_schema_version: LONGMEMEVAL_TRACE_SCHEMA_VERSION,
				entry_sha256: entrySha256,
				question_sha256: questionSha256,
				status: executionError ? "execution_error" : "completed",
				attempt,
				answerer_model: answererModel,
				judge_model: judgeModel,
				...(executionError
					? { execution_error: { stage: "judge", message: judgeResult.error ?? "judge failure" } }
					: {}),
				token_usage: sumTokenUsage([answerUsage, judgeUsage]),
				question_id: entry.question_id,
				question: entry.question,
				question_date: entry.question_date,
				answer: answerStr,
				response,
				prediction: response,
				ground_truth: answerStr,
				question_type: entry.question_type,
				llm_score: isCorrect ? 1 : 0,
				correct: isCorrect,
				f1_score: metrics.f1,
				bleu_score: metrics.bleu1,
				bleu1: metrics.bleu1,
				bleu2: metrics.bleu2,
				bleu3: metrics.bleu3,
				bleu4: metrics.bleu4,
				evidence_session_ids: entry.answer_session_ids,
				trace: { retrieval: retrievalTrace, answerer: answerTrace, judge: judgeTrace },
				failure_stage: deriveFailureStage({
					entry,
					retrieval: retrievalTrace,
					correct: isCorrect,
					...(executionError ? { executionStage: "judge" as const } : {}),
				}),
			};

			await this.saveCheckpoint(entry.question_id, pred);

			return pred;
		} catch (error) {
			const pred = this.createExecutionErrorPrediction(entry, error, executionStage, attempt, {
				retrieval: retrievalTrace,
				answerer: answerTrace,
				judge: judgeTrace,
			});
			pred.token_usage = sumTokenUsage([answerUsage, judgeUsage]);
			await this.saveCheckpoint(entry.question_id, pred);
			return pred;
		}
	}
}
