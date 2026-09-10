import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./opencontext-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./opencontext-client")>();
	return { ...actual, generateAnswer: vi.fn(), searchMemory: vi.fn() };
});

vi.mock("./metrics", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./metrics")>();
	return { ...actual, evaluateLLMJudge: vi.fn() };
});

import { buildSampleMessages, LoCoMoEvaluator } from "./evaluator";
import { evaluateLLMJudge, getJudgeModelIdentity, parseLLMJudgeResponse } from "./metrics";
import { generateAnswer, searchMemory } from "./opencontext-client";
import type { LoCoMoSample } from "./types";
import { RetrievalMode } from "./types";

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
		prompt_version: "locomo-judge-v1",
		prompt_sha256: "fixture-hash",
		prompt_characters: 10,
		system_prompt: "fixture system",
		prompt: "fixture prompt",
		raw_response: score === 1 ? '{"label":"CORRECT"}' : '{"label":"WRONG"}',
		parse_status: "parsed" as const,
	};
}

function searchResponse() {
	return { query: "fixture", sources: ["memory"], results: [], count: 0, warnings: [] };
}

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function createCheckpointDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "opencontext-locomo-checkpoint-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createEvaluator(checkpointDir: string, resume = true): LoCoMoEvaluator {
	const evaluator = new LoCoMoEvaluator(
		RetrievalMode.OBSERVATION,
		"http://fixture.invalid",
		undefined,
		resume,
	);
	Object.assign(evaluator, { checkpointDir, ingestedCount: 1 });
	return evaluator;
}

function createSample(questionCount = 1): LoCoMoSample {
	return {
		sample_id: "fixture-sample",
		conversation: {},
		observation: {},
		session_summary: {},
		event_summary: {},
		qa_pairs: Array.from({ length: questionCount }, (_, index) => ({
			question: `Question ${index + 1}?`,
			answer: `Answer ${index + 1}`,
			category: 1,
			evidence: [],
		})),
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

describe("LoCoMo checkpoint resume", () => {
	it("reuses both correct and incorrect completed results", async () => {
		const checkpointDir = await createCheckpointDir();
		const sample = createSample(2);
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(1)).mockResolvedValueOnce(judgeResult(0));

		const first = await createEvaluator(checkpointDir).evaluateQA(sample);
		expect(first.correct_answers).toBe(1);
		expect(first.token_usage).toEqual({ prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 });

		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockClear();
		const resumed = await createEvaluator(checkpointDir).evaluateQA(sample);

		expect(generateAnswer).not.toHaveBeenCalled();
		expect(evaluateLLMJudge).not.toHaveBeenCalled();
		expect(resumed.predictions.map((prediction) => prediction.correct)).toEqual([true, false]);
	});

	it("restores session evidence when an entire sample is checkpoint-complete", async () => {
		const checkpointDir = await createCheckpointDir();
		const sample = createSample();
		sample.observation = { session_1_observation: { Alice: [["Adopted Luna", "D1:3"]] } };
		sample.conversation = {
			session_1_date_time: "2024-01-02",
			session_1: [{ speaker: "Alice", text: "I adopted Luna.", dia_id: "D1:3" }],
		};
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(1));
		await createEvaluator(checkpointDir).evaluateQA(sample);

		const resumed = createEvaluator(checkpointDir);
		expect(await resumed.reuseCompletedSample(sample)).toBe(true);
		expect(resumed.getSessionTraces()).toMatchObject([
			{ session_id: "1", evidence_ids: ["D1:3"], ingest_status: "completed", ingest_latency_ms: null },
		]);
	});

	it("retries execution errors and increments the benchmark attempt", async () => {
		const checkpointDir = await createCheckpointDir();
		const sample = createSample();
		vi.mocked(evaluateLLMJudge).mockRejectedValueOnce(new Error("judge parse failure"));

		const failed = await createEvaluator(checkpointDir).evaluateQA(sample);
		expect(failed.predictions[0]).toMatchObject({
			status: "execution_error",
			attempt: 1,
			execution_error: { stage: "judge", message: "judge parse failure" },
		});

		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(0));
		const retried = await createEvaluator(checkpointDir).evaluateQA(sample);

		expect(generateAnswer).toHaveBeenCalledOnce();
		expect(retried.predictions[0]).toMatchObject({ status: "completed", attempt: 2, correct: false });
	});

	it("does not reuse checkpoints from different model identities", async () => {
		const checkpointDir = await createCheckpointDir();
		const sample = createSample();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(0));
		await createEvaluator(checkpointDir).evaluateQA(sample);

		process.env.ANSWER_MODEL = "answerer-b";
		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(1));
		const rerun = await createEvaluator(checkpointDir).evaluateQA(sample);
		expect(rerun.predictions[0]).toMatchObject({
			status: "completed",
			attempt: 1,
			answerer_model: "anthropic-compatible:answerer-b",
		});

		const checkpointPath = join(checkpointDir, "fixture-sample.observation.json");
		const checkpoint = JSON.parse(await readFile(checkpointPath, "utf-8")) as Record<
			string,
			Record<string, unknown>
		>;
		checkpoint["0"].judge_model = "different-judge";
		await writeFile(checkpointPath, JSON.stringify(checkpoint), "utf-8");

		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(judgeResult(0));
		const judgeRerun = await createEvaluator(checkpointDir).evaluateQA(sample);
		expect(generateAnswer).toHaveBeenCalledOnce();
		expect(judgeRerun.predictions[0]).toMatchObject({
			status: "completed",
			attempt: 1,
			judge_model: getJudgeModelIdentity(),
		});
	});

	it("records an empty answer as an answerer execution error", async () => {
		const checkpointDir = await createCheckpointDir();
		vi.mocked(generateAnswer).mockResolvedValueOnce({ text: "", token_usage: fixtureUsage, attempt: 1 });

		const result = await createEvaluator(checkpointDir).evaluateQA(createSample());
		expect(evaluateLLMJudge).not.toHaveBeenCalled();
		expect(result.predictions[0]).toMatchObject({
			status: "execution_error",
			execution_error: { stage: "answerer", message: "Answerer returned an empty response" },
		});
	});
});

describe("LoCoMo judge parsing", () => {
	it("accepts explicit labels and rejects an unparseable response", () => {
		expect(parseLLMJudgeResponse('{"label":"CORRECT"}')).toBe(1);
		expect(parseLLMJudgeResponse("WRONG")).toBe(0);
		expect(() => parseLLMJudgeResponse("unknown")).toThrow("could not be parsed");
	});

	it("extracts a JSON label after an explanation without matching incorrectly as CORRECT", () => {
		expect(parseLLMJudgeResponse('The generated answer is incorrect. {"label": "WRONG"}')).toBe(0);
	});
});

describe("LoCoMo raw-session mapping", () => {
	it("preserves one complete dialog session as one RawMessage and retains turn ids", () => {
		const sample = createSample();
		sample.conversation = {
			speaker_a: "Alice",
			speaker_b: "Bob",
			session_1_date_time: "2024-01-02",
			session_1: [
				{ speaker: "Alice", text: "I adopted Luna.", dia_id: "D1:3" },
				{ speaker: "Bob", text: "That is wonderful.", dia_id: "D1:4" },
			],
		};

		const built = buildSampleMessages(sample, RetrievalMode.DIALOG);

		expect(built.messages).toHaveLength(1);
		expect(built.messages[0]).toMatchObject({
			messageId: "locomo_fixture-sample_dialog_1",
			timestamp: Date.UTC(2024, 0, 2),
			metadata: {
				sampleId: "fixture-sample",
				sessionId: "1",
				sessionDate: "2024-01-02",
				evidenceIds: ["D1:3", "D1:4"],
			},
		});
		expect(built.messages[0]?.content).toContain("[D1:3] [Alice] I adopted Luna.");
		expect(built.sessions[0]).toMatchObject({ session_id: "1", ingest_status: "pending" });
	});

	it("retains MiniCPM image descriptions in the source RawMessage", () => {
		const sample = createSample();
		sample.conversation = {
			session_1_date_time: "2024-01-02",
			session_1: [
				{
					speaker: "Alice",
					text: "Here is the photo from my trip.",
					dia_id: "D1:3",
					minicpm_caption: "A red bicycle beside the Eiffel Tower.",
				},
			],
		};

		const built = buildSampleMessages(sample, RetrievalMode.DIALOG);
		expect(built.messages[0]?.content).toContain(
			"[Image description: A red bicycle beside the Eiffel Tower.]",
		);
	});

	it("parses native LoCoMo timestamps deterministically", () => {
		const sample = createSample();
		sample.conversation = {
			session_1_date_time: "1:56 pm on 8 May, 2023",
			session_1: [{ speaker: "Alice", text: "Timestamped turn", dia_id: "D1:1" }],
		};

		const built = buildSampleMessages(sample, RetrievalMode.DIALOG);
		expect(built.messages[0]?.timestamp).toBe(Date.UTC(2023, 4, 8, 13, 56));
	});

	it("adds observation references and original turns without splitting a session", () => {
		const sample = createSample();
		sample.conversation = {
			session_2_date_time: "2024-02-03",
			session_2: [{ speaker: "Alice", text: "Trip detail", dia_id: "D2:1" }],
		};
		sample.observation = { session_2_observation: { Alice: [["Planned a trip", "D2:1"]] } };

		const built = buildSampleMessages(sample, RetrievalMode.OBSERVATION);
		expect(built.messages).toHaveLength(1);
		expect(built.messages[0]?.content).toContain("Alice: Planned a trip [Ref: D2:1]");
		expect(built.messages[0]?.content).toContain("[D2:1] [Alice] Trip detail");
		expect(built.sessions[0]?.evidence_ids).toEqual(["D2:1"]);
	});
});
