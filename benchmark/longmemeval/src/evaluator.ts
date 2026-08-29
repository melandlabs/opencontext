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
import { join } from "node:path";

import { sumTokenUsage, unavailableTokenUsage } from "../../run-support";
import { JUDGE_MODEL, calculateMetrics, evaluateLLMJudge } from "./metrics";
import {
	type BenchRawMessage,
	type GeneratedAnswer,
	type MemorySearchHit,
	checkOpencontextHealth,
	generateAnswer,
	getAnswererModelIdentity,
	getOpencontextBaseUrl,
	ingestMessages,
	searchMemory,
} from "./opencontext-client";
import type { LongMemEvalEntry, Prediction } from "./types";

/** How many retrieved sessions are shown to the answerer. */
export const RETRIEVAL_LIMIT = 8;

function isReusableCheckpoint(
	prediction: Prediction | null,
	answererModel: string,
	judgeModel: string,
): boolean {
	return (
		prediction?.status === "completed" &&
		prediction.answerer_model === answererModel &&
		prediction.judge_model === judgeModel
	);
}

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
function buildSessionMessages(entry: LongMemEvalEntry): BenchRawMessage[] {
	const messages: BenchRawMessage[] = [];

	const { haystack_sessions, haystack_session_ids, haystack_dates } = entry;
	const now = Date.now();

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

		messages.push({
			messageId: `lme_${entry.question_id}__${sessionId}`,
			userId: "benchmark_user",
			platform: "benchmark",
			botId: "longmemeval",
			timestamp: parseTimestamp(date) ?? now,
			content: parts.join("\n"),
			createdAt: now,
			metadata: {
				questionId: entry.question_id,
				sessionId,
				contentType: "session",
			},
		});
	}

	return messages;
}

function buildAnswerPrompt(entry: LongMemEvalEntry, hits: MemorySearchHit[]): string {
	// Build date context for temporal reasoning
	const dateRange =
		entry.haystack_dates.length > 0
			? `${Math.min(...entry.haystack_dates.map((d) => new Date(d).getTime())) > 0 ? entry.haystack_dates.sort()[0] : "unknown"} to ${entry.haystack_dates.sort()[entry.haystack_dates.length - 1]}`
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

/**
 * Evaluator for LongMemEval benchmark using the OpenContext memory store.
 */
export class LongMemEvalEvaluator {
	private baseUrl: string;
	private quickLimit?: number;
	private checkpointDir: string;
	private resume: boolean;

	constructor(baseUrl?: string, quickLimit?: number, resume = true) {
		this.baseUrl = baseUrl ?? getOpencontextBaseUrl();
		this.quickLimit = quickLimit;
		this.resume = resume;
		this.checkpointDir = join(import.meta.dirname, "..", "checkpoints", "longmemeval");
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
		} catch (_error) {}
	}

	/**
	 * Ingest a LongMemEval entry into the OpenContext memory store.
	 */
	async loadEntry(entry: LongMemEvalEntry): Promise<void> {
		const messages = buildSessionMessages(entry);
		const _inserted = await ingestMessages(messages, this.baseUrl, `lme_${entry.question_id}`);
	}

	/**
	 * Evaluate a single question.
	 */
	async evaluateQuestion(entry: LongMemEvalEntry): Promise<Prediction> {
		const checkpoint = await this.loadCheckpoint(entry.question_id);
		const answererModel = getAnswererModelIdentity();
		const judgeModel = JUDGE_MODEL;
		if (checkpoint && isReusableCheckpoint(checkpoint, answererModel, judgeModel)) {
			return checkpoint;
		}
		if (checkpoint) {
			const message =
				checkpoint.status === "execution_error"
					? `Retrying ${entry.question_id}: execution error`
					: `Re-running ${entry.question_id}: legacy/model mismatch`;
			process.stdout.write(`[LongMemEval] ${message}\n`);
		}
		const attempt = (checkpoint?.attempt ?? 0) + 1;

		// Convert answer to string (may be number in dataset)
		const answerStr = String(entry.answer);
		let answerUsage = unavailableTokenUsage();
		let judgeUsage = unavailableTokenUsage();

		try {
			const answerResult = await this.queryMemory(entry);
			const response = answerResult.text;
			answerUsage = answerResult.token_usage;

			// Evaluate answer correctness using LLM judge
			const judgeResult = await evaluateLLMJudge(entry.question, answerStr, response);
			judgeUsage = judgeResult.token_usage;
			const isCorrect = judgeResult.score === 1;

			// Calculate additional metrics
			const metrics = calculateMetrics(response, answerStr);

			const pred: Prediction = {
				status: "completed",
				attempt,
				answerer_model: answererModel,
				judge_model: judgeModel,
				token_usage: sumTokenUsage([answerUsage, judgeUsage]),
				question: entry.question,
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
			};

			// Save checkpoint
			await this.saveCheckpoint(entry.question_id, pred);

			return pred;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);

			const pred: Prediction = {
				status: "execution_error",
				attempt,
				answerer_model: answererModel,
				judge_model: judgeModel,
				error: errorMessage,
				token_usage: sumTokenUsage([answerUsage, judgeUsage]),
				question: entry.question,
				answer: answerStr,
				response: `Error: ${errorMessage}`,
				prediction: `Error: ${errorMessage}`,
				ground_truth: answerStr,
				question_type: entry.question_type,
				llm_score: 0,
				correct: false,
				f1_score: 0.0,
				bleu_score: 0.0,
				bleu1: 0.0,
				bleu2: 0.0,
				bleu3: 0.0,
				bleu4: 0.0,
				evidence_session_ids: entry.answer_session_ids,
			};

			await this.saveCheckpoint(entry.question_id, pred);
			return pred;
		}
	}

	/**
	 * Retrieve relevant memories and answer the question with the answerer LLM.
	 */
	private async queryMemory(entry: LongMemEvalEntry): Promise<GeneratedAnswer> {
		const hits = await searchMemory(
			entry.question,
			RETRIEVAL_LIMIT,
			this.baseUrl,
			`lme_${entry.question_id}`,
		);
		const prompt = buildAnswerPrompt(entry, hits);
		const response = await generateAnswer(prompt);
		if (!response.text.trim()) {
			throw new Error("Answerer returned an empty response");
		}
		return response;
	}
}
