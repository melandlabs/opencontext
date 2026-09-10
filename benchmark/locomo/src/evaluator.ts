/**
 * LoCoMo evaluator. The benchmark maps one upstream session to one RawMessage;
 * OpenContext owns chunking, indexing, retrieval, fusion, and reranking.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sumTokenUsage, type TokenUsage, unavailableTokenUsage } from "../../run-support";
import {
	buildRetrievalErrorTrace,
	buildRetrievalTrace,
	deriveFailureStage,
	extractEvidenceIds,
	sha256Text,
} from "./diagnostics";
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
	LOCOMO_TRACE_SCHEMA_VERSION,
	type EvaluationResult,
	type LoCoMoAnswerTrace,
	type LoCoMoJudgeTrace,
	type LoCoMoRetrievalTrace,
	type LoCoMoSample,
	type LoCoMoSessionTrace,
	type Prediction,
	type QAPair,
	RetrievalMode,
} from "./types";

const configuredRetrievalLimit = Number.parseInt(process.env.LOCOMO_TOP_K ?? "8", 10);
export const RETRIEVAL_LIMIT =
	Number.isInteger(configuredRetrievalLimit) && configuredRetrievalLimit > 0
		? Math.min(50, configuredRetrievalLimit)
		: 8;

interface DialogTurn {
	speaker?: string;
	dia_id?: string;
	text?: string;
	minicpm_caption?: string;
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function parseTimestamp(timestamp: string): number | undefined {
	if (!timestamp) return undefined;
	const locomoDate = timestamp.match(
		/^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/i,
	);
	if (locomoDate) {
		const [, hourText, minuteText, meridiem, dayText, monthText, yearText] = locomoDate;
		const months = [
			"january",
			"february",
			"march",
			"april",
			"may",
			"june",
			"july",
			"august",
			"september",
			"october",
			"november",
			"december",
		];
		const month = months.indexOf(monthText.toLowerCase());
		let hour = Number.parseInt(hourText, 10) % 12;
		if (meridiem.toLowerCase() === "pm") hour += 12;
		if (month >= 0) {
			return Date.UTC(
				Number.parseInt(yearText, 10),
				month,
				Number.parseInt(dayText, 10),
				hour,
				Number.parseInt(minuteText, 10),
			);
		}
	}
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizedSessionId(value: string): string {
	return value.replace(/^session_/, "");
}

function sessionSortValue(value: string): [number, string] {
	const match = value.match(/(\d+)/);
	return [match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER, value];
}

function sortSessionKeys(keys: string[]): string[] {
	return keys.sort((left, right) => {
		const [leftNumber, leftText] = sessionSortValue(left);
		const [rightNumber, rightText] = sessionSortValue(right);
		return leftNumber - rightNumber || leftText.localeCompare(rightText);
	});
}

function conversationDate(sample: LoCoMoSample, sessionId: string): string {
	return String(sample.conversation[`session_${sessionId}_date_time`] ?? "");
}

function conversationTurns(sample: LoCoMoSample, sessionId: string): unknown[] {
	const value = sample.conversation[`session_${sessionId}`];
	return Array.isArray(value) ? value : [];
}

function dialogTurn(value: unknown): DialogTurn | null {
	return typeof value === "object" && value !== null ? (value as DialogTurn) : null;
}

function formatDialogTurn(value: unknown, timestamp: string): string {
	if (typeof value === "string") return timestamp ? `[${timestamp}] ${value}` : value;
	const turn = dialogTurn(value);
	const evidence = turn?.dia_id ? `[${turn.dia_id}] ` : "";
	const speaker = turn?.speaker ? `[${turn.speaker}] ` : "";
	const text = turn?.text ?? JSON.stringify(value);
	const caption = turn?.minicpm_caption?.trim();
	const imageDescription = caption ? `\n[Image description: ${caption}]` : "";
	return `${timestamp ? `[${timestamp}] ` : ""}${evidence}${speaker}${text}${imageDescription}`;
}

function evidenceIdsFromTurns(turns: unknown[]): string[] {
	return unique(
		turns.flatMap((value) => {
			const id = dialogTurn(value)?.dia_id;
			return typeof id === "string" && id.length > 0 ? [id] : [];
		}),
	);
}

function toMessageAndTrace(input: {
	sample: LoCoMoSample;
	retrievalMode: RetrievalMode;
	sessionId: string;
	sessionIndex: number;
	timestamp: string;
	content: string;
	evidenceIds: string[];
	now: number;
}): { message: BenchRawMessage; trace: LoCoMoSessionTrace } {
	const messageId = `locomo_${input.sample.sample_id}_${input.retrievalMode}_${input.sessionId}`;
	const message: BenchRawMessage = {
		messageId,
		userId: "benchmark_user",
		platform: "benchmark",
		botId: "locomo",
		timestamp: parseTimestamp(input.timestamp) ?? input.now,
		content: input.content,
		createdAt: input.now,
		metadata: {
			sampleId: input.sample.sample_id,
			sessionId: input.sessionId,
			contentType: input.retrievalMode,
			sessionDate: input.timestamp || null,
			evidenceIds: input.evidenceIds,
		},
	};
	return {
		message,
		trace: {
			schema_version: LOCOMO_TRACE_SCHEMA_VERSION,
			sample_id: input.sample.sample_id,
			retrieval_mode: input.retrievalMode,
			message_id: messageId,
			session_id: input.sessionId,
			session_index: input.sessionIndex,
			ingest_batch_index: Math.floor(input.sessionIndex / INGEST_BATCH_SIZE),
			session_date: input.timestamp || null,
			evidence_ids: input.evidenceIds,
			content_sha256: sha256Text(input.content),
			content_characters: input.content.length,
			ingest_status: "pending",
			ingest_latency_ms: null,
			ingest_warnings: [],
		},
	};
}

function createMessagesFromDialog(sample: LoCoMoSample, now: number) {
	const speakerA = sample.conversation.speaker_a ?? "Speaker A";
	const speakerB = sample.conversation.speaker_b ?? "Speaker B";
	const keys = sortSessionKeys(
		Object.keys(sample.conversation).filter(
			(key) => key.startsWith("session_") && !key.endsWith("_date_time"),
		),
	);
	return keys.map((key, sessionIndex) => {
		const sessionId = normalizedSessionId(key);
		const timestamp = conversationDate(sample, sessionId);
		const turns = conversationTurns(sample, sessionId);
		const parts = [
			`# Conversation Session ${sessionId}`,
			...(timestamp ? [`# Timestamp: ${timestamp}`] : []),
			`# Speakers: ${speakerA}, ${speakerB}`,
			"",
			...turns.map((turn) => formatDialogTurn(turn, timestamp)),
		];
		return toMessageAndTrace({
			sample,
			retrievalMode: RetrievalMode.DIALOG,
			sessionId,
			sessionIndex,
			timestamp,
			content: parts.join("\n"),
			evidenceIds: evidenceIdsFromTurns(turns),
			now,
		});
	});
}

function createMessagesFromObservation(sample: LoCoMoSample, now: number) {
	const keys = sortSessionKeys(Object.keys(sample.observation).filter((key) => key.endsWith("_observation")));
	return keys.map((key, sessionIndex) => {
		const sessionId = normalizedSessionId(key.replace(/_observation$/, ""));
		const timestamp = conversationDate(sample, sessionId);
		const observation = sample.observation[key];
		const parts = [
			`# Observation Summary ${sessionId}`,
			...(timestamp ? [`# Session Date: ${timestamp}`] : []),
			"",
		];
		if (typeof observation === "object" && observation !== null) {
			for (const [speaker, utterances] of Object.entries(observation)) {
				if (!Array.isArray(utterances)) continue;
				for (const item of utterances) {
					if (Array.isArray(item) && item.length >= 2) parts.push(`${speaker}: ${item[0]} [Ref: ${item[1]}]`);
					else parts.push(`${speaker}: ${String(item)}`);
				}
			}
		} else {
			parts.push(String(observation));
		}
		const turns = conversationTurns(sample, sessionId);
		if (turns.length > 0) {
			parts.push("", "# Original Dialog (for date/time reasoning):");
			parts.push(...turns.map((turn) => formatDialogTurn(turn, "")));
		}
		const content = parts.join("\n");
		return toMessageAndTrace({
			sample,
			retrievalMode: RetrievalMode.OBSERVATION,
			sessionId,
			sessionIndex,
			timestamp,
			content,
			evidenceIds: unique([...evidenceIdsFromTurns(turns), ...extractEvidenceIds(content)]),
			now,
		});
	});
}

function createMessagesFromSummary(sample: LoCoMoSample, now: number) {
	const keys = sortSessionKeys(Object.keys(sample.session_summary).filter((key) => key.endsWith("_summary")));
	return keys.map((key, sessionIndex) => {
		const sessionId = normalizedSessionId(key.replace(/_summary$/, ""));
		const timestamp = conversationDate(sample, sessionId);
		const summary = sample.session_summary[key];
		const parts = [`# Session Summary ${sessionId}`, ...(timestamp ? [`# Timestamp: ${timestamp}`] : []), ""];
		if (typeof summary === "object" && summary !== null) {
			for (const [speaker, text] of Object.entries(summary)) parts.push(`${speaker}: ${String(text)}`);
		} else {
			parts.push(String(summary));
		}
		const content = parts.join("\n");
		return toMessageAndTrace({
			sample,
			retrievalMode: RetrievalMode.SESSION_SUMMARY,
			sessionId,
			sessionIndex,
			timestamp,
			content,
			evidenceIds: extractEvidenceIds(content),
			now,
		});
	});
}

export function buildSampleMessages(
	sample: LoCoMoSample,
	retrievalMode: RetrievalMode,
): { messages: BenchRawMessage[]; sessions: LoCoMoSessionTrace[] } {
	const now = Date.now();
	const built =
		retrievalMode === RetrievalMode.DIALOG
			? createMessagesFromDialog(sample, now)
			: retrievalMode === RetrievalMode.OBSERVATION
				? createMessagesFromObservation(sample, now)
				: createMessagesFromSummary(sample, now);
	return {
		messages: built.map((item) => item.message),
		sessions: built.map((item) => item.trace),
	};
}

export function fingerprintSample(sample: LoCoMoSample): string {
	return sha256Text(JSON.stringify(sample));
}

export function fingerprintQuestion(
	sample: LoCoMoSample,
	qa: QAPair,
	questionIndex: number,
	retrievalMode: RetrievalMode,
): string {
	return sha256Text(
		JSON.stringify({
			sample_id: sample.sample_id,
			question_index: questionIndex,
			question: qa.question,
			answer: qa.answer,
			category: qa.category,
			evidence: qa.evidence,
			retrieval_mode: retrievalMode,
			top_k: RETRIEVAL_LIMIT,
		}),
	);
}

function applyIngestBatchTraces(sessions: LoCoMoSessionTrace[], batches: IngestBatchTrace[]): void {
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

function buildAnswerPrompt(qa: QAPair, sample: LoCoMoSample, hits: MemorySearchHit[]): string {
	const speakerA = sample.conversation.speaker_a ?? "Speaker A";
	const speakerB = sample.conversation.speaker_b ?? "Speaker B";
	const excerpts = hits
		.map(
			(hit, index) =>
				`--- Memory excerpt ${index + 1} (id=${hit.id}, score=${hit.similarity.toFixed(3)}) ---\n${hit.content}`,
		)
		.join("\n\n");
	const categoryGuidance =
		qa.category === 5
			? "- This is an ADVERSARIAL question. If the excerpts do not contain the relevant information, say you don't know — do not guess or hallucinate."
			: qa.category === 2
				? "- This is a TEMPORAL question. Use the timestamps in the excerpts as the authoritative dates. Convert every relative time reference into a specific date, month, or year."
				: qa.category === 1
					? "- This is a MULTI-HOP question. The answer requires combining information from multiple excerpts — cite each fact you use."
					: qa.category === 3
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

export { checkOpencontextHealth, getOpencontextBaseUrl };

function locomoUserId(sample: LoCoMoSample): string {
	return `locomo_${sample.sample_id}`;
}

export function getLoCoMoCheckpointDir(): string {
	const configured = process.env.LOCOMO_CHECKPOINT_DIR?.trim();
	return configured ? resolve(configured) : join(import.meta.dirname, "..", "checkpoints", "locomo");
}

export class LoCoMoEvaluator {
	private retrievalMode: RetrievalMode;
	private baseUrl: string;
	private quickLimit?: number;
	private checkpointDir: string;
	private resume: boolean;
	private ingestedCount = 0;
	private sessionTraces = new Map<string, LoCoMoSessionTrace>();
	private sampleFingerprints = new Map<string, string>();

	constructor(
		retrievalMode: RetrievalMode | string = RetrievalMode.DIALOG,
		baseUrl?: string,
		quickLimit?: number,
		resume = true,
	) {
		this.retrievalMode = Object.values(RetrievalMode).includes(retrievalMode as RetrievalMode)
			? (retrievalMode as RetrievalMode)
			: RetrievalMode.DIALOG;
		this.baseUrl = baseUrl ?? getOpencontextBaseUrl();
		this.quickLimit = quickLimit;
		this.resume = resume;
		this.checkpointDir = getLoCoMoCheckpointDir();
	}

	private getCheckpointPath(sampleId: string): string {
		return join(this.checkpointDir, `${sampleId}.${this.retrievalMode}.json`);
	}

	private async loadCheckpoint(sampleId: string): Promise<Record<number, Prediction> | null> {
		if (!this.resume) return null;
		try {
			return JSON.parse(await readFile(this.getCheckpointPath(sampleId), "utf-8")) as Record<
				number,
				Prediction
			>;
		} catch {
			return null;
		}
	}

	private async saveCheckpoint(sampleId: string, predictions: Record<number, Prediction>): Promise<void> {
		try {
			await mkdir(this.checkpointDir, { recursive: true });
			await writeFile(this.getCheckpointPath(sampleId), JSON.stringify(predictions, null, 2), "utf-8");
		} catch (error) {
			process.stderr.write(`Failed to save checkpoint: ${error}\n`);
		}
	}

	private selectedQuestions(sample: LoCoMoSample): QAPair[] {
		return this.quickLimit ? sample.qa_pairs.slice(0, this.quickLimit) : sample.qa_pairs;
	}

	private checkpointMatches(
		prediction: Prediction | undefined,
		sample: LoCoMoSample,
		qa: QAPair,
		questionIndex: number,
	): boolean {
		return (
			prediction?.trace_schema_version === LOCOMO_TRACE_SCHEMA_VERSION &&
			prediction.sample_sha256 ===
				(this.sampleFingerprints.get(sample.sample_id) ?? fingerprintSample(sample)) &&
			prediction.question_sha256 === fingerprintQuestion(sample, qa, questionIndex, this.retrievalMode) &&
			prediction.retrieval_mode === this.retrievalMode &&
			prediction.answerer_model === getAnswererModelIdentity() &&
			prediction.judge_model === getJudgeModelIdentity()
		);
	}

	getSessionTraces(): LoCoMoSessionTrace[] {
		return [...this.sessionTraces.values()];
	}

	async reuseCompletedSample(sample: LoCoMoSample): Promise<boolean> {
		if (!this.resume) return false;
		this.sampleFingerprints.set(sample.sample_id, fingerprintSample(sample));
		const checkpoint = await this.loadCheckpoint(sample.sample_id);
		const questions = this.selectedQuestions(sample);
		if (
			!checkpoint ||
			questions.length === 0 ||
			!questions.every(
				(qa, questionIndex) =>
					checkpoint[questionIndex]?.status === "completed" &&
					this.checkpointMatches(checkpoint[questionIndex], sample, qa, questionIndex),
			)
		) {
			return false;
		}
		const { messages, sessions } = buildSampleMessages(sample, this.retrievalMode);
		for (const session of sessions) {
			session.ingest_status = "completed";
			session.ingest_warnings = [
				"Restored from context-matched completed checkpoints; original ingest latency was not persisted.",
			];
			this.sessionTraces.set(session.message_id, session);
		}
		this.ingestedCount = messages.length;
		return true;
	}

	async loadSample(sample: LoCoMoSample): Promise<number> {
		const { messages, sessions } = buildSampleMessages(sample, this.retrievalMode);
		if (messages.length === 0)
			throw new Error(`No ${this.retrievalMode} sessions found in ${sample.sample_id}`);
		this.sampleFingerprints.set(sample.sample_id, fingerprintSample(sample));
		for (const session of sessions) this.sessionTraces.set(session.message_id, session);
		const startedAt = performance.now();
		try {
			const result = await ingestMessages(messages, this.baseUrl, locomoUserId(sample));
			applyIngestBatchTraces(sessions, result.batches);
			this.ingestedCount = messages.length;
			process.stdout.write(
				`[LoCoMo] Ingested ${result.inserted} raw sessions for ${sample.sample_id} (mode: ${this.retrievalMode}) → ${this.baseUrl}\n`,
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

	createExecutionErrorPrediction(
		sample: LoCoMoSample,
		qa: QAPair,
		questionIndex: number,
		error: unknown,
		stage: "ingest" | "retrieval" | "answerer" | "judge" | "provider",
		attempt = 1,
		trace: {
			retrieval?: LoCoMoRetrievalTrace | null;
			answerer?: LoCoMoAnswerTrace | null;
			judge?: LoCoMoJudgeTrace | null;
		} = {},
		tokenUsage: TokenUsage = unavailableTokenUsage(),
	): Prediction {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			trace_schema_version: LOCOMO_TRACE_SCHEMA_VERSION,
			sample_sha256: this.sampleFingerprints.get(sample.sample_id) ?? fingerprintSample(sample),
			question_sha256: fingerprintQuestion(sample, qa, questionIndex, this.retrievalMode),
			status: "execution_error",
			attempt,
			answerer_model: getAnswererModelIdentity(),
			judge_model: getJudgeModelIdentity(),
			execution_error: { stage, message: errorMessage },
			token_usage: tokenUsage,
			sample_id: sample.sample_id,
			question_index: questionIndex,
			retrieval_mode: this.retrievalMode,
			question: qa.question,
			answer: qa.answer,
			response: `Error: ${errorMessage}`,
			prediction: `Error: ${errorMessage}`,
			ground_truth: qa.answer,
			category: String(qa.category),
			llm_score: 0,
			correct: false,
			f1_score: 0,
			bleu_score: 0,
			bleu1: 0,
			bleu2: 0,
			bleu3: 0,
			bleu4: 0,
			evidence: qa.evidence,
			trace: {
				retrieval: trace.retrieval ?? null,
				answerer: trace.answerer ?? null,
				judge: trace.judge ?? null,
			},
			failure_stage: deriveFailureStage({
				qa,
				retrieval: trace.retrieval ?? null,
				correct: false,
				executionStage: stage,
			}),
		};
	}

	createIngestErrorResult(sample: LoCoMoSample, error: unknown): EvaluationResult {
		const predictions = this.selectedQuestions(sample).map((qa, questionIndex) =>
			this.createExecutionErrorPrediction(sample, qa, questionIndex, error, "ingest"),
		);
		return {
			sample_id: sample.sample_id,
			retrieval_mode: this.retrievalMode,
			total_questions: predictions.length,
			correct_answers: 0,
			accuracy: 0,
			token_usage: sumTokenUsage(predictions.map((prediction) => prediction.token_usage)),
			predictions,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	async evaluateQA(sample: LoCoMoSample): Promise<EvaluationResult> {
		if (this.ingestedCount === 0) return this.createIngestErrorResult(sample, "No records in storage");

		const checkpoint = (await this.loadCheckpoint(sample.sample_id)) ?? {};
		const questions = this.selectedQuestions(sample);
		const predictions: Prediction[] = [];
		let correct = 0;
		let reused = 0;
		let retrying = 0;
		let incompatible = 0;

		for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
			const qa = questions[questionIndex];
			const existing = checkpoint[questionIndex];
			const matches = this.checkpointMatches(existing, sample, qa, questionIndex);
			if (existing?.status === "completed" && matches) reused++;
			else if (existing?.status === "execution_error" && matches) retrying++;
			else if (existing) incompatible++;
		}
		if (Object.keys(checkpoint).length > 0) {
			process.stdout.write(
				`[LoCoMo] Resume: ${reused} completed result(s) reused, ${retrying} execution error(s) retrying, ${incompatible} trace/data/model-mismatched result(s) re-running\n`,
			);
		}

		for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
			const qa = questions[questionIndex];
			const existing = checkpoint[questionIndex];
			const checkpointMatches = this.checkpointMatches(existing, sample, qa, questionIndex);
			if (existing?.status === "completed" && checkpointMatches) {
				predictions.push(existing);
				if (existing.correct) correct++;
				continue;
			}
			const attempt =
				existing?.status === "execution_error" && checkpointMatches ? (existing.attempt ?? 0) + 1 : 1;
			let answerUsage = unavailableTokenUsage();
			let judgeUsage = unavailableTokenUsage();
			let retrievalTrace: LoCoMoRetrievalTrace | null = null;
			let answerTrace: LoCoMoAnswerTrace | null = null;
			let judgeTrace: LoCoMoJudgeTrace | null = null;
			let executionStage: "retrieval" | "answerer" | "judge" = "retrieval";

			try {
				const sampleSessions = this.getSessionTraces().filter(
					(session) =>
						session.sample_id === sample.sample_id && session.retrieval_mode === this.retrievalMode,
				);
				const availableEvidenceIds = unique(sampleSessions.flatMap((session) => session.evidence_ids));
				const searchStartedAt = performance.now();
				let searchResponse: MemorySearchResponse;
				try {
					searchResponse = await searchMemory(
						qa.question,
						RETRIEVAL_LIMIT,
						this.baseUrl,
						locomoUserId(sample),
						{ includeRetrievalDiagnostics: true },
					);
				} catch (error) {
					retrievalTrace = buildRetrievalErrorTrace({
						qa,
						availableEvidenceIds,
						userId: locomoUserId(sample),
						topK: RETRIEVAL_LIMIT,
						latencyMs: Math.round(performance.now() - searchStartedAt),
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
				retrievalTrace = buildRetrievalTrace({
					qa,
					response: searchResponse,
					sessionsByMessageId: new Map(
						sampleSessions.map((session) => [session.message_id, session] as const),
					),
					availableEvidenceIds,
					userId: locomoUserId(sample),
					topK: RETRIEVAL_LIMIT,
					latencyMs: Math.round(performance.now() - searchStartedAt),
				});

				const hits = searchResponse.results;
				const prompt = buildAnswerPrompt(qa, sample, hits);
				executionStage = "answerer";
				const answerStartedAt = performance.now();
				let response: string;
				let answerAttempt = 1;
				try {
					const answerResult = await generateAnswer(prompt);
					if (!answerResult.text.trim()) throw new Error("Answerer returned an empty response");
					answerUsage = answerResult.token_usage;
					answerAttempt = answerResult.attempt;
					response = answerResult.text;
					answerTrace = {
						model: getAnswererModelIdentity(),
						status: "completed",
						attempt: answerAttempt,
						latency_ms: Math.round(performance.now() - answerStartedAt),
						prompt_version: "locomo-answer-v1",
						prompt_sha256: sha256Text(prompt),
						prompt_characters: prompt.length,
						system_prompt: null,
						prompt,
						token_usage: answerUsage,
						included_hit_ids: hits.map((hit) => hit.id),
						included_context_characters: hits.reduce((sum, hit) => sum + hit.content.length, 0),
					};
				} catch (error) {
					answerAttempt = error instanceof AnswererGenerationError ? error.attempts : answerAttempt;
					answerTrace = {
						model: getAnswererModelIdentity(),
						status: "execution_error",
						attempt: answerAttempt,
						latency_ms: Math.round(performance.now() - answerStartedAt),
						prompt_version: "locomo-answer-v1",
						prompt_sha256: sha256Text(prompt),
						prompt_characters: prompt.length,
						system_prompt: null,
						prompt,
						token_usage: answerUsage,
						included_hit_ids: hits.map((hit) => hit.id),
						included_context_characters: hits.reduce((sum, hit) => sum + hit.content.length, 0),
						error: error instanceof Error ? error.message : String(error),
					};
					throw error;
				}

				executionStage = "judge";
				const judgeResult = await evaluateLLMJudge(qa.question, qa.answer, response);
				judgeUsage = judgeResult.token_usage;
				judgeTrace = {
					model: getJudgeModelIdentity(),
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
				if (judgeResult.status === "execution_error") {
					throw new Error(judgeResult.error ?? "Judge failed without returning a result");
				}

				const isCorrect = judgeResult.score === 1;
				const metrics = calculateMetrics(response, qa.answer);
				const prediction: Prediction = {
					trace_schema_version: LOCOMO_TRACE_SCHEMA_VERSION,
					sample_sha256: this.sampleFingerprints.get(sample.sample_id) ?? fingerprintSample(sample),
					question_sha256: fingerprintQuestion(sample, qa, questionIndex, this.retrievalMode),
					status: "completed",
					attempt,
					answerer_model: getAnswererModelIdentity(),
					judge_model: getJudgeModelIdentity(),
					token_usage: sumTokenUsage([answerUsage, judgeUsage]),
					sample_id: sample.sample_id,
					question_index: questionIndex,
					retrieval_mode: this.retrievalMode,
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
					trace: { retrieval: retrievalTrace, answerer: answerTrace, judge: judgeTrace },
					failure_stage: deriveFailureStage({ qa, retrieval: retrievalTrace, correct: isCorrect }),
				};
				predictions.push(prediction);
				checkpoint[questionIndex] = prediction;
				await this.saveCheckpoint(sample.sample_id, checkpoint);
				if (isCorrect) correct++;
			} catch (error) {
				const prediction = this.createExecutionErrorPrediction(
					sample,
					qa,
					questionIndex,
					error,
					executionStage,
					attempt,
					{ retrieval: retrievalTrace, answerer: answerTrace, judge: judgeTrace },
					sumTokenUsage([answerUsage, judgeUsage]),
				);
				predictions.push(prediction);
				checkpoint[questionIndex] = prediction;
				await this.saveCheckpoint(sample.sample_id, checkpoint);
			}
		}

		return {
			sample_id: sample.sample_id,
			retrieval_mode: this.retrievalMode,
			total_questions: questions.length,
			correct_answers: correct,
			accuracy: questions.length > 0 ? correct / questions.length : 0,
			token_usage: sumTokenUsage(predictions.map((prediction) => prediction.token_usage)),
			predictions,
		};
	}
}
