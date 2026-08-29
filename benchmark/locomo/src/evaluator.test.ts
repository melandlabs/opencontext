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

import { LoCoMoEvaluator } from "./evaluator";
import { JUDGE_MODEL, evaluateLLMJudge, parseLLMJudgeResponse } from "./metrics";
import { generateAnswer, searchMemory } from "./opencontext-client";
import type { LoCoMoSample } from "./types";

const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalAnswerModel = process.env.ANSWER_MODEL;
const temporaryDirectories: string[] = [];

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
	const evaluator = new LoCoMoEvaluator("observation", "http://fixture.invalid", undefined, resume);
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
	vi.mocked(searchMemory).mockResolvedValue([]);
	vi.mocked(generateAnswer).mockResolvedValue("fixture response");
});

afterEach(async () => {
	restoreEnvironment("ANTHROPIC_AUTH_TOKEN", originalAuthToken);
	restoreEnvironment("ANSWER_MODEL", originalAnswerModel);
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("LoCoMo checkpoint resume", () => {
	it("reuses both correct and incorrect completed results across repeated resumes", async () => {
		const checkpointDir = await createCheckpointDir();
		const sample = createSample(2);
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(1).mockResolvedValueOnce(0);

		const first = await createEvaluator(checkpointDir).evaluateQA(sample);
		expect(first.correct_answers).toBe(1);
		expect(first.predictions.map((prediction) => prediction.status)).toEqual(["completed", "completed"]);

		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockClear();
		const second = await createEvaluator(checkpointDir).evaluateQA(sample);
		const third = await createEvaluator(checkpointDir).evaluateQA(sample);

		expect(generateAnswer).not.toHaveBeenCalled();
		expect(evaluateLLMJudge).not.toHaveBeenCalled();
		expect(second.correct_answers).toBe(1);
		expect(third.correct_answers).toBe(1);
		expect(second.predictions.map((prediction) => prediction.correct)).toEqual([true, false]);
	});

	it("retries execution errors and increments the attempt", async () => {
		const checkpointDir = await createCheckpointDir();
		const sample = createSample();
		vi.mocked(evaluateLLMJudge).mockRejectedValueOnce(new Error("judge parse failure"));

		const failed = await createEvaluator(checkpointDir).evaluateQA(sample);
		expect(failed.predictions[0]).toMatchObject({
			status: "execution_error",
			attempt: 1,
			error: "judge parse failure",
		});

		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(0);
		const retried = await createEvaluator(checkpointDir).evaluateQA(sample);

		expect(generateAnswer).toHaveBeenCalledOnce();
		expect(retried.predictions[0]).toMatchObject({ status: "completed", attempt: 2, correct: false });
	});

	it("ignores existing checkpoints when resume is disabled", async () => {
		const checkpointDir = await createCheckpointDir();
		const sample = createSample();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(0);
		await createEvaluator(checkpointDir).evaluateQA(sample);

		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(1);
		const fresh = await createEvaluator(checkpointDir, false).evaluateQA(sample);

		expect(generateAnswer).toHaveBeenCalledOnce();
		expect(fresh.predictions[0]).toMatchObject({ status: "completed", attempt: 1, correct: true });
	});

	it("does not reuse a checkpoint from a different answerer or judge model", async () => {
		const checkpointDir = await createCheckpointDir();
		const sample = createSample();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(0);
		await createEvaluator(checkpointDir).evaluateQA(sample);

		process.env.ANSWER_MODEL = "answerer-b";
		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(1);
		const rerun = await createEvaluator(checkpointDir).evaluateQA(sample);

		expect(generateAnswer).toHaveBeenCalledOnce();
		expect(rerun.predictions[0]).toMatchObject({
			status: "completed",
			attempt: 2,
			answerer_model: "anthropic-compatible:answerer-b",
		});

		const checkpointPath = join(checkpointDir, "fixture-sample.json");
		const checkpoint = JSON.parse(await readFile(checkpointPath, "utf-8")) as Record<
			string,
			Record<string, unknown>
		>;
		checkpoint["0"].judge_model = "different-judge";
		await writeFile(checkpointPath, JSON.stringify(checkpoint), "utf-8");

		vi.mocked(generateAnswer).mockClear();
		vi.mocked(evaluateLLMJudge).mockResolvedValueOnce(0);
		const judgeRerun = await createEvaluator(checkpointDir).evaluateQA(sample);

		expect(generateAnswer).toHaveBeenCalledOnce();
		expect(judgeRerun.predictions[0]).toMatchObject({
			status: "completed",
			attempt: 3,
			judge_model: JUDGE_MODEL,
		});
	});

	it("records an empty answer as an execution error without calling the judge", async () => {
		const checkpointDir = await createCheckpointDir();
		vi.mocked(generateAnswer).mockResolvedValueOnce("");

		const result = await createEvaluator(checkpointDir).evaluateQA(createSample());

		expect(evaluateLLMJudge).not.toHaveBeenCalled();
		expect(result.predictions[0]).toMatchObject({
			status: "execution_error",
			error: "Answerer returned an empty response",
		});
	});
});

describe("LoCoMo judge parsing", () => {
	it("accepts explicit labels and rejects an unparseable response", () => {
		expect(parseLLMJudgeResponse('{"label":"CORRECT"}')).toBe(1);
		expect(parseLLMJudgeResponse("WRONG")).toBe(0);
		expect(() => parseLLMJudgeResponse("unknown")).toThrow("could not be parsed");
	});
});
