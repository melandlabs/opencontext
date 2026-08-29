/**
 * BEAM Evaluator for the OpenContext memory store.
 *
 * Flow (no agent, no filesystem — pure memory-store HTTP):
 *   1. loadConversation: chunk the conversation and POST the chunks to the
 *      OpenContext daemon (`POST /v1/raw-messages`, embedOnInsert).
 *   2. evaluateQuestion: retrieve relevant chunks (`POST /v1/search`),
 *      then ask the answerer LLM (see opencontext-client.ts) using only
 *      the retrieved excerpts.
 *   3. Judge unchanged (metrics.ts, OpenRouter).
 *
 * Differences from the LongMemEval evaluator:
 *   - Conversations can be enormous (1M avg 842 turns, 10M avg 7,757 turns).
 *     We chunk by `CHUNK_TURNS` and ingest one memory message per chunk.
 *   - Each chunk keeps its timestamp range in the text header so
 *     date-aware questions can reason about time.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sumTokenUsage, unavailableTokenUsage, zeroTokenUsage } from "../../run-support";
import {
	type NuggetJudgeResult,
	evaluateNuggetJudge,
	looksLikeAbstention,
	summarizeNuggetScores,
} from "./metrics";
import {
	type BenchRawMessage,
	type MemorySearchHit,
	checkOpencontextHealth,
	generateAnswer,
	getOpencontextBaseUrl,
	ingestMessages,
	searchMemory,
} from "./opencontext-client";
import type { BeamConversation, BeamProbingQuestion, BeamTurn, Prediction } from "./types";

/**
 * How many turns go into a single ingested memory message.
 *
 * 20 ≈ 1 LongMemEval session. Smaller chunks explode the message count for
 * the 10M bucket; larger chunks hurt retrieval precision.
 */
export const CHUNK_TURNS = 20;

/** How many retrieved chunks are shown to the answerer. */
export const RETRIEVAL_LIMIT = 8;

function parseTimestampMs(ts: string | undefined): number | undefined {
	if (!ts) return undefined;
	try {
		const ms = new Date(ts).getTime();
		return Number.isFinite(ms) ? ms : undefined;
	} catch {
		return undefined;
	}
}

function formatTimestamp(ts: string | undefined): string {
	if (!ts) return "(unknown)";
	try {
		return new Date(ts).toISOString();
	} catch {
		return ts;
	}
}

function buildChunkText(
	conv: BeamConversation,
	chunkIndex: number,
	startTurn: number,
	endTurn: number,
	turns: BeamTurn[],
): string {
	const header =
		`# ${conv.entry_id} — chunk ${chunkIndex}\n` +
		`# Turns ${startTurn}..${endTurn} of ${conv.chat.length}\n` +
		`# Scale: ${conv.scale}\n` +
		`# First turn: ${formatTimestamp(turns[0]?.timestamp)}\n` +
		`# Last turn:  ${formatTimestamp(turns[turns.length - 1]?.timestamp)}\n\n`;

	const body = turns
		.map((turn) => {
			const ts = turn.timestamp ? ` (${turn.timestamp})` : "";
			return `**${turn.speaker}${ts}:** ${turn.text}`;
		})
		.join("\n\n");

	return `${header}${body}\n`;
}

/**
 * Convert a BEAM conversation into raw messages for the memory store.
 */
function buildConversationMessages(conv: BeamConversation): BenchRawMessage[] {
	const messages: BenchRawMessage[] = [];
	const now = Date.now();

	let chunkIndex = 0;
	for (let i = 0; i < conv.chat.length; i += CHUNK_TURNS) {
		const slice = conv.chat.slice(i, i + CHUNK_TURNS);
		const startTurn = i;
		const endTurn = i + slice.length - 1;
		const text = buildChunkText(conv, chunkIndex, startTurn, endTurn, slice);

		const firstTs = slice[0]?.timestamp;
		const lastTs = slice[slice.length - 1]?.timestamp;

		messages.push({
			messageId: `beam_${conv.entry_id}__chunk_${chunkIndex}`,
			userId: "benchmark_user",
			platform: "benchmark",
			botId: "beam",
			timestamp: parseTimestampMs(firstTs) ?? parseTimestampMs(lastTs) ?? now,
			content: text,
			createdAt: now,
			metadata: {
				entryId: conv.entry_id,
				chunkIndex,
				scale: conv.scale,
				contentType: "beam_chunk",
				turnStart: startTurn,
				turnEnd: endTurn,
			},
		});

		chunkIndex++;
	}

	return messages;
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
	return `beam_${conv.entry_id}`;
}

export class BeamEvaluator {
	private baseUrl: string;
	private quickLimit?: number;
	private checkpointDir: string;
	private resume: boolean;

	constructor(baseUrl?: string, quickLimit?: number, resume = true) {
		this.baseUrl = baseUrl ?? getOpencontextBaseUrl();
		this.quickLimit = quickLimit;
		this.resume = resume;
		this.checkpointDir = join(import.meta.dirname, "..", "checkpoints", "beam");
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

	/**
	 * Ingest a BEAM conversation into the OpenContext memory store.
	 * Returns the number of ingested chunk messages.
	 */
	async loadConversation(conv: BeamConversation): Promise<number> {
		const messages = buildConversationMessages(conv);
		const inserted = await ingestMessages(messages, this.baseUrl, beamUserId(conv));
		console.log(`[BEAM] Ingested ${inserted} chunk messages for ${conv.entry_id} → ${this.baseUrl}`);
		return messages.length;
	}

	/**
	 * Evaluate one BEAM question against the ingested conversation.
	 */
	async evaluateQuestion(
		conv: BeamConversation,
		question: BeamProbingQuestion,
		_chunkCount: number,
	): Promise<Prediction> {
		// Resume support — but re-judge on resume so a stale judge doesn't
		// poison the run if we re-run with a new judge model.
		const checkpoint = await this.loadCheckpoint(question.question_id);
		if (
			checkpoint?.response &&
			!checkpoint.response.startsWith("Error:") &&
			checkpoint.nugget_scores.length === question.atoms.length &&
			!checkpoint.judge_reasoning.startsWith("judge failure")
		) {
			console.log(`[BEAM] Resuming from checkpoint for ${question.question_id}`);
			return checkpoint;
		}

		let answerUsage = unavailableTokenUsage();
		let judgeUsage = unavailableTokenUsage();
		try {
			const hits = await searchMemory(question.question, RETRIEVAL_LIMIT, this.baseUrl, beamUserId(conv));
			const prompt = buildAnswerPrompt(conv, question, hits);
			const answerResult = await generateAnswer(prompt);
			answerUsage = answerResult.token_usage;
			const response = answerResult.text;
			if (!response.trim()) throw new Error("answerer returned an empty response");

			const abstained = looksLikeAbstention(response);

			let judgeResult: NuggetJudgeResult;
			if (question.atoms.length === 0) {
				console.warn(`[BEAM] Question ${question.question_id} has no atoms — using empty judge result`);
				judgeResult = { scores: [], reasoning: "no atoms", token_usage: zeroTokenUsage() };
			} else {
				judgeResult = await evaluateNuggetJudge(
					question.question,
					question.category,
					question.atoms,
					response,
				);
			}
			judgeUsage = judgeResult.token_usage;

			const { nugget_mean, nugget_pass } = summarizeNuggetScores(judgeResult.scores);

			const pred: Prediction = {
				token_usage: sumTokenUsage([answerUsage, judgeUsage]),
				question_id: question.question_id,
				question: question.question,
				response,
				prediction: response,
				atoms: question.atoms,
				category: question.category,
				scale: conv.scale,
				nugget_scores: judgeResult.scores,
				nugget_mean,
				nugget_pass,
				judge_reasoning: judgeResult.reasoning,
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

			const emptyScores: number[] = question.atoms.map(() => 0);
			const pred: Prediction = {
				token_usage: sumTokenUsage([answerUsage, judgeUsage]),
				question_id: question.question_id,
				question: question.question,
				response: `Error: ${errorMessage}`,
				prediction: `Error: ${errorMessage}`,
				atoms: question.atoms,
				category: question.category,
				scale: conv.scale,
				nugget_scores: emptyScores,
				nugget_mean: 0,
				nugget_pass: false,
				judge_reasoning: `agent failure: ${errorMessage}`,
				abstained: false,
			};

			await this.saveCheckpoint(question.question_id, pred);
			return pred;
		}
	}
}
