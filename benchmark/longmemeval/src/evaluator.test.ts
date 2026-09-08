import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./opencontext-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./opencontext-client")>();
	return {
		...actual,
		generateAnswer: vi.fn(),
		searchMemory: vi.fn(),
	};
});

vi.mock("./metrics", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./metrics")>();
	return {
		...actual,
		evaluateLLMJudge: vi.fn(),
	};
});

import { LongMemEvalEvaluator, buildSessionMessages } from "./evaluator";
import { evaluateLLMJudge, getJudgeModelIdentity, parseLLMJudgeResponse } from "./metrics";
import { generateAnswer, searchMemory } from "./opencontext-client";
import type { LongMemEvalEntry } from "./types";

const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalAnswerModel = process.env.ANSWER_MODEL;
const originalJudgeModel = process.env.OPENROUTER_JUDGE_MODEL;
const temporaryDirectories: string[] = [];
const fixtureUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function judgeResult(score: number) {
	return {
		score,
		token_usage: fixtureUsage,
		status: "completed" as const,
		attempt: 1,
		latency_ms: 1,
		prompt_version: "longmemeval-judge-v1",
		prompt_sha256: "fixture-hash",
		prompt_characters: 10,
		system_prompt: "fixture system",
		prompt: "fixture prompt",
		raw_response: score === 1 ? '{"label":"CORRECT"}' : '{"label":"WRONG"}',
		parse_status: "parsed" as const,
	};
}

function searchResponse() {
	return {
		query: "fixture",
		sources: ["memory"],
		results: [],
		count: 0,
		warnings: [],
	};
}

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function createCheckpointDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "opencontext-longmemeval-checkpoint-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createEvaluator(checkpointDir: string, resume = true): LongMemEvalEvaluator {
	const evaluator = new LongMemEvalEvaluator("http://fixture.invalid", undefined, resume);
	Object.assign(evaluator, { checkpointDir });
	return evaluator;
}

function createEntry(questionId: string): LongMemEvalEntry {
	return {
		question_id: questionId,
		question_type: "single-session-user",
		question: `Question for ${questionId}?`,
		question_date: "2024-01-01",
		answer: `Answer for ${questionId}`,
		answer_session_ids: [],
		haystack_dates: [],
		haystack_session_ids: [],
		haystack_sessions: [],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	process.env.ANTHROPIC_AUTH_TOKEN = "fixture-token";
	process.env.ANSWER_MODEL = "answerer-a";
	process.env.OPENROUTER_JUDGE_MODEL = "judge-a";
	vi.mocked(searchMemory).mockResolvedValue(searchResponse());
	vi.mocked(generateAnswer).mockResolvedValue({
		text: "fixture response",
		token_usage: fixtureUsage,
		attempt: 1,
	});
});

afterEach(async () => {
	restoreEnvironment("ANTHROPIC_AUTH_TOKEN", originalAuthToken);
	restoreEnvironment("ANSWER_MODEL", originalAnswerModel);
	restoreEnvironment("OPENROUTER_JUDGE_MODEL", originalJudgeModel);
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("LongMemEval checkpoint resume", () => {
	it("reuses both correct and incorrect completed results across repeated resumes", async () => {
		const checkpointDir = await createCheckpointDir();
		const correctEntry = createEntry("correct-entry");
		const incorrectEntry = createEntry("incorrect-entry");
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(1)).mockResolvedValueOnce(judgeResult(0));

		const firstEvaluator = createEvaluator(checkpointDir);
		const correct = await firstEvaluator.evaluateQuestion(correctEntry);
		const incorrect = await firstEvaluator.evaluateQuestion(incorrectEntry);
		expect([correct.status, incorrect.status]).toEqual(["completed", "completed"]);
		expect(correct.token_usage).toEqual({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });

		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockClear();
		const secondEvaluator = createEvaluator(checkpointDir);
		const resumedCorrect = await secondEvaluator.evaluateQuestion(correctEntry);
		const resumedIncorrect = await secondEvaluator.evaluateQuestion(incorrectEntry);
		const resumedAgain = await createEvaluator(checkpointDir).evaluateQuestion(incorrectEntry);

		expect(generateAnswer).not.toHaveBeenCalled();
		expect(evaluateLLMJudge).not.toHaveBeenCalled();
		expect(resumedCorrect.correct).toBe(true);
		expect(resumedIncorrect.correct).toBe(false);
		expect(resumedAgain.correct).toBe(false);
	});

	it("restores raw-session evidence from a matched completed checkpoint without reingesting", async () => {
		const checkpointDir = await createCheckpointDir();
		const entry = createEntry("restored-entry");
		entry.haystack_dates = ["2024-01-02"];
		entry.haystack_session_ids = ["session-1"];
		entry.haystack_sessions = [[{ role: "user", content: "Remember this." }]];
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(1));
		await createEvaluator(checkpointDir).evaluateQuestion(entry);

		const resumed = createEvaluator(checkpointDir);
		const reused = await resumed.reuseCompletedCheckpoint(entry);

		expect(reused).toMatchObject({ status: "completed", question_id: "restored-entry" });
		expect(resumed.getSessionTraces()).toMatchObject([
			{
				message_id: "lme_restored-entry__session-1",
				ingest_status: "completed",
				ingest_latency_ms: null,
			},
		]);
	});

	it("retries execution errors and increments the attempt", async () => {
		const checkpointDir = await createCheckpointDir();
		const entry = createEntry("retry-entry");
		vi.mocked(evaluateLLMJudge).mockRejectedValueOnce(new Error("judge parse failure"));

		const failed = await createEvaluator(checkpointDir).evaluateQuestion(entry);
		expect(failed).toMatchObject({
			status: "execution_error",
			attempt: 1,
			execution_error: { stage: "judge", message: "judge parse failure" },
		});

		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(0));
		const retried = await createEvaluator(checkpointDir).evaluateQuestion(entry);

		expect(generateAnswer).toHaveBeenCalledOnce();
		expect(retried).toMatchObject({ status: "completed", attempt: 2, correct: false });
	});

	it("ignores existing checkpoints when resume is disabled", async () => {
		const checkpointDir = await createCheckpointDir();
		const entry = createEntry("fresh-entry");
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(0));
		await createEvaluator(checkpointDir).evaluateQuestion(entry);

		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(1));
		const fresh = await createEvaluator(checkpointDir, false).evaluateQuestion(entry);

		expect(generateAnswer).toHaveBeenCalledOnce();
		expect(fresh).toMatchObject({ status: "completed", attempt: 1, correct: true });
	});

	it("does not reuse a checkpoint from a different answerer or judge model", async () => {
		const checkpointDir = await createCheckpointDir();
		const entry = createEntry("model-entry");
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(0));
		await createEvaluator(checkpointDir).evaluateQuestion(entry);

		process.env.ANSWER_MODEL = "answerer-b";
		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(1));
		const rerun = await createEvaluator(checkpointDir).evaluateQuestion(entry);

		expect(generateAnswer).toHaveBeenCalledOnce();
		expect(rerun).toMatchObject({
			status: "completed",
			attempt: 1,
			answerer_model: "anthropic-compatible:answerer-b",
		});

		const checkpointPath = join(checkpointDir, `${entry.question_id}.json`);
		const checkpoint = JSON.parse(await readFile(checkpointPath, "utf-8")) as Record<string, unknown>;
		checkpoint.judge_model = "different-judge";
		await writeFile(checkpointPath, JSON.stringify(checkpoint), "utf-8");

		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(0));
		const judgeRerun = await createEvaluator(checkpointDir).evaluateQuestion(entry);

		expect(generateAnswer).toHaveBeenCalledOnce();
		expect(judgeRerun).toMatchObject({
			status: "completed",
			attempt: 1,
			judge_model: getJudgeModelIdentity(),
		});
	});

	it("records an empty answer as an execution error without calling the judge", async () => {
		const checkpointDir = await createCheckpointDir();
		vi.mocked(generateAnswer).mockResolvedValueOnce({ text: "", token_usage: fixtureUsage, attempt: 1 });

		const result = await createEvaluator(checkpointDir).evaluateQuestion(createEntry("empty-entry"));

		expect(evaluateLLMJudge).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "execution_error",
			execution_error: { stage: "answerer", message: "Answerer returned an empty response" },
		});
	});
});

describe("LongMemEval judge parsing", () => {
	it("accepts explicit labels and rejects an unparseable response", () => {
		expect(parseLLMJudgeResponse('{"label":"CORRECT"}')).toBe(1);
		expect(parseLLMJudgeResponse("WRONG")).toBe(0);
		expect(() => parseLLMJudgeResponse("unknown")).toThrow("could not be parsed");
	});
});

describe("LongMemEval raw-session mapping", () => {
	it("preserves one complete dataset session as one raw message for daemon-owned chunking", () => {
		const entry = createEntry("mapping-entry");
		entry.haystack_dates = ["2024-01-02"];
		entry.haystack_session_ids = ["session-1"];
		entry.haystack_sessions = [
			[
				{ role: "user", content: "I adopted Luna." },
				{ role: "assistant", content: "That is wonderful." },
			],
		];
		entry.answer_session_ids = ["session-1"];

		const built = buildSessionMessages(entry);

		expect(built.messages).toHaveLength(1);
		expect(built.messages[0]).toMatchObject({
			messageId: "lme_mapping-entry__session-1",
			metadata: { sessionId: "session-1", sessionDate: "2024-01-02", turnCount: 2 },
		});
		expect(built.messages[0]?.content).toContain("User: I adopted Luna.");
		expect(built.messages[0]?.content).toContain("Assistant: That is wonderful.");
		expect(built.sessions[0]).toMatchObject({
			session_id: "session-1",
			turn_count: 2,
			ingest_status: "pending",
		});
	});

	it("disambiguates duplicate dataset session ids without changing ordinary message ids", () => {
		const entry = createEntry("duplicate-session-entry");
		entry.haystack_dates = ["2024-01-02", "2024-01-03", "2024-01-04"];
		entry.haystack_session_ids = ["same-session", "ordinary-session", "same-session"];
		entry.haystack_sessions = [
			[{ role: "user", content: "First duplicate." }],
			[{ role: "user", content: "Ordinary." }],
			[{ role: "user", content: "Second duplicate." }],
		];

		const built = buildSessionMessages(entry);

		expect(built.messages.map((message) => message.messageId)).toEqual([
			"lme_duplicate-session-entry__same-session__0",
			"lme_duplicate-session-entry__ordinary-session",
			"lme_duplicate-session-entry__same-session__2",
		]);
	});
});
