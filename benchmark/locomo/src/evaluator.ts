/**
 * LoCoMo Evaluator for the OpenContext memory store.
 *
 * Flow (no agent, no filesystem — pure memory-store HTTP):
 *   1. loadSample: convert the sample's sessions into raw messages and POST
 *      them to the OpenContext daemon (`POST /v1/raw-messages`, embedOnInsert).
 *      Granularity is unchanged: one memory message per session record
 *      (dialog / observation / session_summary, depending on retrieval mode).
 *   2. evaluateQA: retrieve relevant memories (`POST /v1/search`), then ask
 *      the answerer LLM (see opencontext-client.ts) using only the retrieved
 *      excerpts.
 *   3. Judge with the existing metrics.ts model and prompt (OpenRouter).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { JUDGE_MODEL, calculateMetrics, evaluateLLMJudge } from "./metrics";
import {
	type BenchRawMessage,
	type MemorySearchHit,
	generateAnswer,
	getAnswererModelIdentity,
	getOpencontextBaseUrl,
	ingestMessages,
	searchMemory,
} from "./opencontext-client";
import { RetrievalMode } from "./types";
import type { EvaluationResult, LoCoMoSample, Prediction, QAPair } from "./types";

/** How many retrieved memories are shown to the answerer. */
export const RETRIEVAL_LIMIT = 8;

function isReusableCheckpoint(
	prediction: Prediction | undefined,
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

function toBenchMessage(
	id: string,
	sessionTimestamp: string,
	content: string,
	metadata: Record<string, unknown>,
	now: number,
): BenchRawMessage {
	return {
		messageId: `locomo_${id}`,
		userId: "benchmark_user",
		platform: "benchmark",
		botId: "locomo",
		timestamp: parseTimestamp(sessionTimestamp) ?? now,
		content,
		createdAt: now,
		metadata,
	};
}

/**
 * Format conversation data into raw memory messages (one per session).
 */
function createMessagesFromDialog(sample: LoCoMoSample, now: number): BenchRawMessage[] {
	const messages: BenchRawMessage[] = [];
	const speakerA = sample.conversation.speaker_a ?? "Speaker A";
	const speakerB = sample.conversation.speaker_b ?? "Speaker B";

	for (const key of Object.keys(sample.conversation).sort()) {
		if (!key.startsWith("session_") || key.endsWith("_date_time")) {
			continue;
		}

		const sessionNum = key.replace("session_", "");
		const datetimeKey = `session_${sessionNum}_date_time`;
		const sessionTimestamp = String(sample.conversation[datetimeKey] ?? "");
		const session = sample.conversation[key] as unknown[];

		const dialogParts: string[] = [];
		dialogParts.push(`# Conversation Session ${sessionNum}`);
		if (sessionTimestamp) {
			dialogParts.push(`# Timestamp: ${sessionTimestamp}`);
		}
		dialogParts.push(`# Speakers: ${speakerA}, ${speakerB}`);
		dialogParts.push("");

		for (const turn of session) {
			// Each turn is an object with speaker, dia_id, and text properties
			const turnText =
				typeof turn === "string" ? turn : (turn as { text?: string }).text || JSON.stringify(turn);
			const speaker = typeof turn === "string" ? "" : `[${(turn as { speaker?: string }).speaker || ""}] `;
			if (sessionTimestamp) {
				dialogParts.push(`[${sessionTimestamp}] ${speaker}${turnText}`);
			} else {
				dialogParts.push(`${speaker}${turnText}`);
			}
		}

		messages.push(
			toBenchMessage(
				`${sample.sample_id}_dialog_${sessionNum}`,
				sessionTimestamp,
				dialogParts.join("\n"),
				{
					sampleId: sample.sample_id,
					sessionId: sessionNum,
					contentType: "dialog",
				},
				now,
			),
		);
	}

	return messages;
}

/**
 * Format observation data into raw memory messages (one per session).
 */
function createMessagesFromObservation(sample: LoCoMoSample, now: number): BenchRawMessage[] {
	const messages: BenchRawMessage[] = [];

	for (const key of Object.keys(sample.observation).sort()) {
		if (!key.endsWith("_observation")) {
			continue;
		}

		const sessionNum = key.replace("_observation", "");
		const datetimeKey = `${sessionNum}_date_time`;
		const sessionTimestamp = String(sample.conversation[datetimeKey] ?? "");
		const obsContent = sample.observation[key];

		const obsParts: string[] = [];
		obsParts.push(`# Observation Summary ${sessionNum}`);
		if (sessionTimestamp) {
			obsParts.push(`# Session Date: ${sessionTimestamp}`);
		}
		obsParts.push("");

		// Add observation summary with dialog references
		if (typeof obsContent === "object" && obsContent !== null) {
			for (const [speaker, utterances] of Object.entries(obsContent)) {
				if (Array.isArray(utterances)) {
					for (const item of utterances) {
						if (Array.isArray(item) && item.length >= 2) {
							const [text, diaId] = item;
							// Include text and its dialog reference
							obsParts.push(`${speaker}: ${text} [Ref: ${diaId}]`);
						} else {
							obsParts.push(`${speaker}: ${item}`);
						}
					}
				}
			}
		} else {
			obsParts.push(String(obsContent));
		}

		obsParts.push("");

		// Add original dialog for this session to enable temporal reasoning
		const sessionKey = `session_${sessionNum}`;
		const dialogContent = sample.conversation[sessionKey];
		if (Array.isArray(dialogContent)) {
			obsParts.push("# Original Dialog (for date/time reasoning):");
			for (const turn of dialogContent) {
				if (typeof turn === "object" && turn !== null && "speaker" in turn && "text" in turn) {
					obsParts.push(`${turn.speaker}: ${turn.text}`);
				} else if (typeof turn === "string") {
					obsParts.push(turn);
				}
			}
		}

		messages.push(
			toBenchMessage(
				`${sample.sample_id}_observation_${sessionNum}`,
				sessionTimestamp,
				obsParts.join("\n"),
				{
					sampleId: sample.sample_id,
					sessionId: sessionNum,
					contentType: "observation",
				},
				now,
			),
		);
	}

	return messages;
}

/**
 * Format session summary data into raw memory messages (one per session).
 */
function createMessagesFromSummary(sample: LoCoMoSample, now: number): BenchRawMessage[] {
	const messages: BenchRawMessage[] = [];

	for (const key of Object.keys(sample.session_summary).sort()) {
		if (!key.endsWith("_summary")) {
			continue;
		}

		const sessionNum = key.replace("_summary", "");
		const datetimeKey = `${sessionNum}_date_time`;
		const sessionTimestamp = String(sample.conversation[datetimeKey] ?? "");
		const summaryContent = sample.session_summary[key];

		const summaryParts: string[] = [];
		summaryParts.push(`# Session Summary ${sessionNum}`);
		if (sessionTimestamp) {
			summaryParts.push(`# Timestamp: ${sessionTimestamp}`);
		}
		summaryParts.push("");

		if (typeof summaryContent === "object" && summaryContent !== null) {
			for (const [speaker, text] of Object.entries(summaryContent)) {
				summaryParts.push(`${speaker}: ${text}`);
			}
		} else {
			summaryParts.push(String(summaryContent));
		}

		messages.push(
			toBenchMessage(
				`${sample.sample_id}_summary_${sessionNum}`,
				sessionTimestamp,
				summaryParts.join("\n"),
				{
					sampleId: sample.sample_id,
					sessionId: sessionNum,
					contentType: "session_summary",
				},
				now,
			),
		);
	}

	return messages;
}

/**
 * Build the answer prompt from retrieved memory excerpts.
 */
function buildAnswerPrompt(qa: QAPair, sample: LoCoMoSample, hits: MemorySearchHit[]): string {
	const speakerA = sample.conversation.speaker_a ?? "Speaker A";
	const speakerB = sample.conversation.speaker_b ?? "Speaker B";

	const excerpts = hits
		.map(
			(h, i) =>
				`--- Memory excerpt ${i + 1} (id=${h.id}, score=${h.similarity.toFixed(3)}) ---\n${h.content}`,
		)
		.join("\n\n");

	const categoryGuidance =
		qa.category === 5
			? `- This is an ADVERSARIAL question. If the excerpts do not contain the relevant information, say you don't know — do not guess or hallucinate.`
			: qa.category === 2
				? "- This is a TEMPORAL question. Use the timestamps in the excerpts as the authoritative dates. Convert every relative time reference into a specific date, month, or year."
				: qa.category === 3
					? "- This is a MULTI-HOP question. The answer requires combining information from multiple excerpts — cite each fact you use."
					: qa.category === 4
						? "- This is an OPEN-DOMAIN question. Ground your answer in the excerpts; do not invent facts that are not there."
						: "- This is a SINGLE-HOP question. Pull the specific fact from the excerpts.";

	return `You are a helpful assistant answering questions about a multi-session conversation between ${speakerA} and ${speakerB}.
The conversation was previously stored in a memory system. Below are the memory
excerpts the system retrieved for this question. Answer using ONLY these excerpts.

# INSTRUCTIONS:
1. Carefully analyze all provided memory excerpts
2. Pay special attention to timestamps to determine the answer
3. If the question asks about a specific event or fact, look for direct evidence in the memories
4. If the memories contain contradictory information, prioritize the most recent memory
5. If there is a question about time references (like "last year", "two months ago", etc.),
   calculate the actual date based on the memory timestamp. For example, if a memory from
   4 May 2022 mentions "went to India last year," then the trip occurred in 2021.
6. Always convert relative time references to specific dates, months, or years.
7. Focus only on the content of the memories. Do not confuse character names mentioned in memories with the speakers.
8. If you see references like [Ref: D1:3], these refer to specific dialog turns - use them for context.

QUESTION CATEGORY: ${qa.category}

CATEGORY-SPECIFIC GUIDANCE:
${categoryGuidance}

RETRIEVED MEMORY EXCERPTS (${hits.length}):
${excerpts || "(the memory system returned no relevant excerpts)"}

---

Question: ${qa.question}

Answer based only on the retrieved memory excerpts above:`;
}

/**
 * Evaluator for the LoCoMo benchmark against the OpenContext memory store.
 */
export class LoCoMoEvaluator {
	private retrievalMode: RetrievalMode;
	private baseUrl: string;
	private quickLimit?: number;
	private checkpointDir: string;
	private resume: boolean;
	private ingestedCount = 0;

	constructor(
		retrievalMode: RetrievalMode | string = RetrievalMode.OBSERVATION,
		baseUrl?: string,
		quickLimit?: number,
		resume = true,
	) {
		// Convert string to enum if needed
		if (typeof retrievalMode === "string") {
			const modeMap: Record<string, RetrievalMode> = {
				dialog: RetrievalMode.DIALOG,
				observation: RetrievalMode.OBSERVATION,
				session_summary: RetrievalMode.SESSION_SUMMARY,
			};
			this.retrievalMode = modeMap[retrievalMode] || RetrievalMode.OBSERVATION;
		} else {
			this.retrievalMode = retrievalMode;
		}
		this.baseUrl = baseUrl ?? getOpencontextBaseUrl();
		this.quickLimit = quickLimit;
		this.resume = resume;
		this.checkpointDir = join(import.meta.dirname, "..", "checkpoints", "locomo");
	}

	/**
	 * Get checkpoint file path for a sample
	 */
	private getCheckpointPath(sampleId: string): string {
		return join(this.checkpointDir, `${sampleId}.json`);
	}

	/**
	 * Load checkpoint for a sample if it exists
	 */
	private async loadCheckpoint(sampleId: string): Promise<Record<number, Prediction> | null> {
		if (!this.resume) return null;
		try {
			const path = this.getCheckpointPath(sampleId);
			const data = await readFile(path, "utf-8");
			const parsed = JSON.parse(data);
			// Return predictions keyed by question index
			return parsed as Record<number, Prediction>;
		} catch {
			return null;
		}
	}

	/**
	 * Save checkpoint for a sample after each question is evaluated
	 */
	private async saveCheckpoint(sampleId: string, predictions: Record<number, Prediction>): Promise<void> {
		try {
			await mkdir(this.checkpointDir, { recursive: true });
			const path = this.getCheckpointPath(sampleId);
			await writeFile(path, JSON.stringify(predictions, null, 2), "utf-8");
		} catch (error) {
			console.error(`Failed to save checkpoint: ${error}`);
		}
	}

	/**
	 * Ingest a LoCoMo sample into the OpenContext memory store.
	 * Returns the number of ingested memory messages.
	 */
	async loadSample(sample: LoCoMoSample): Promise<number> {
		const now = Date.now();

		// Build memory messages based on retrieval mode (one per session)
		let messages: BenchRawMessage[];

		if (this.retrievalMode === RetrievalMode.DIALOG) {
			messages = createMessagesFromDialog(sample, now);
		} else if (this.retrievalMode === RetrievalMode.OBSERVATION) {
			messages = createMessagesFromObservation(sample, now);
		} else if (this.retrievalMode === RetrievalMode.SESSION_SUMMARY) {
			messages = createMessagesFromSummary(sample, now);
		} else {
			messages = [];
		}

		const inserted = await ingestMessages(messages, this.baseUrl, `locomo_${sample.sample_id}`);
		this.ingestedCount = messages.length;

		console.log(
			`[LoCoMo] Ingested ${inserted} memory messages for ${sample.sample_id} (mode: ${this.retrievalMode}) → ${this.baseUrl}`,
		);
		return messages.length;
	}

	/**
	 * Evaluate question answering on a LoCoMo sample.
	 */
	async evaluateQA(sample: LoCoMoSample): Promise<EvaluationResult> {
		if (this.ingestedCount === 0) {
			return {
				sample_id: sample.sample_id,
				retrieval_mode: this.retrievalMode,
				total_questions: sample.qa_pairs.length,
				correct_answers: 0,
				accuracy: 0,
				token_usage: {
					prompt_tokens: 0,
					completion_tokens: 0,
					total_tokens: 0,
				},
				predictions: [],
				error: "No records in storage",
			};
		}

		const checkpoint = (await this.loadCheckpoint(sample.sample_id)) || {};
		const answererModel = getAnswererModelIdentity();
		const judgeModel = JUDGE_MODEL;
		const reusableIndices = new Set<number>();
		let executionErrorsToRetry = 0;
		let incompatibleCheckpoints = 0;

		for (const [idx, pred] of Object.entries(checkpoint)) {
			const i = Number(idx);
			if (isReusableCheckpoint(pred, answererModel, judgeModel)) {
				reusableIndices.add(i);
			} else if (pred?.status === "execution_error") {
				executionErrorsToRetry++;
			} else {
				incompatibleCheckpoints++;
			}
		}

		const predictions: Prediction[] = [];
		let correct = 0;

		if (Object.keys(checkpoint).length > 0) {
			console.log(
				`[LoCoMo] Resume: ${reusableIndices.size} completed result(s) reused, ${executionErrorsToRetry} execution error(s) retrying, ${incompatibleCheckpoints} legacy/model-mismatched result(s) re-running`,
			);
		}

		// Limit questions if quick mode is enabled
		const questionsToEvaluate = this.quickLimit ? sample.qa_pairs.slice(0, this.quickLimit) : sample.qa_pairs;

		console.log(
			`[LoCoMo] Evaluating ${questionsToEvaluate.length} questions (quick limit: ${this.quickLimit || "none"})`,
		);

		for (let i = 0; i < questionsToEvaluate.length; i++) {
			const qa = questionsToEvaluate[i];

			const existing = checkpoint[i];
			if (reusableIndices.has(i)) {
				predictions.push(existing);
				if (existing.correct) correct++;
				continue;
			}
			const attempt = (existing?.attempt ?? 0) + 1;

			try {
				// Retrieve relevant memories, then answer using only those excerpts
				const response = await this.answerQuestion(qa, sample);

				// Evaluate answer correctness using LLM judge
				const isCorrect = (await evaluateLLMJudge(qa.question, qa.answer, response)) === 1;
				console.log(
					`[Q${i + 1}] ${isCorrect ? "✓" : "✗"} Q: "${qa.question.substring(0, 60)}..." GT: "${qa.answer}"`,
				);
				if (!isCorrect) {
					console.log(`    Agent response: "${response.substring(0, 300)}..."`);
				}

				if (isCorrect) {
					correct++;
				}

				// Calculate additional metrics
				const metrics = calculateMetrics(response, qa.answer);

				const pred: Prediction = {
					status: "completed",
					attempt,
					answerer_model: answererModel,
					judge_model: judgeModel,
					question: qa.question,
					answer: qa.answer,
					response,
					prediction: response,
					ground_truth: qa.answer,
					category: String(qa.category),
					llm_score: isCorrect ? 1 : 0,
					correct: isCorrect,
					f1_score: metrics.f1,
					bleu_score: metrics.bleu1,
					bleu1: metrics.bleu1,
					bleu2: metrics.bleu2,
					bleu3: metrics.bleu3,
					bleu4: metrics.bleu4,
					evidence: qa.evidence,
				};

				predictions.push(pred);

				// Save checkpoint after each question
				checkpoint[i] = pred;
				await this.saveCheckpoint(sample.sample_id, checkpoint);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				const errorCause = error instanceof Error && error.cause ? String(error.cause) : "";
				console.error(
					`Error evaluating question: ${errorMessage}${errorCause ? ` (cause: ${errorCause})` : ""}`,
				);

				const pred: Prediction = {
					status: "execution_error",
					attempt,
					answerer_model: answererModel,
					judge_model: judgeModel,
					error: errorMessage,
					question: qa.question,
					answer: qa.answer,
					response: `Error: ${errorMessage}`,
					prediction: `Error: ${errorMessage}`,
					ground_truth: qa.answer,
					category: String(qa.category),
					llm_score: 0,
					correct: false,
					f1_score: 0.0,
					bleu_score: 0.0,
					bleu1: 0.0,
					bleu2: 0.0,
					bleu3: 0.0,
					bleu4: 0.0,
					evidence: qa.evidence,
				};

				predictions.push(pred);

				// Save checkpoint after each question
				checkpoint[i] = pred;
				await this.saveCheckpoint(sample.sample_id, checkpoint);
			}
		}

		const total = sample.qa_pairs.length;

		return {
			sample_id: sample.sample_id,
			retrieval_mode: this.retrievalMode,
			total_questions: total,
			correct_answers: correct,
			accuracy: total > 0 ? correct / total : 0,
			token_usage: {
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0,
			},
			predictions,
		};
	}

	/**
	 * Answer a question using retrieved memory excerpts.
	 */
	private async answerQuestion(qa: QAPair, sample: LoCoMoSample): Promise<string> {
		const hits = await searchMemory(qa.question, RETRIEVAL_LIMIT, this.baseUrl, `locomo_${sample.sample_id}`);
		const prompt = buildAnswerPrompt(qa, sample, hits);
		const response = await generateAnswer(prompt);
		if (!response.trim() || response === "(empty response)") {
			throw new Error("Answerer returned an empty response");
		}
		return response;
	}
}
