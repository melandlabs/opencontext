import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	collectPreflightErrors,
	sumTokenUsage,
	tokenUsage,
	unavailableTokenUsage,
	writeRunManifest,
} from "../../run-support";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "opencontext-benchmark-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("benchmark run support", () => {
	it("reports independent preflight failures together before execution", async () => {
		const directory = await makeTemporaryDirectory();
		const dataset = join(directory, "fixture.json");
		await writeFile(dataset, "{}", "utf-8");
		vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
		vi.stubEnv("OPENROUTER_API_KEY", "");

		const errors = await collectPreflightErrors({
			datasetPath: dataset,
			writablePaths: [join(directory, "nested", "result.json")],
			parameterErrors: ["--port must be valid"],
			validateDataset: async () => {
				throw new Error("fixture schema is invalid");
			},
			checkDaemon: async () => {
				throw new Error("daemon is unavailable");
			},
		});

		expect(errors).toEqual([
			"--port must be valid",
			"dataset validation failed: fixture schema is invalid",
			"daemon is unavailable",
			"answerer credential missing: set ANTHROPIC_AUTH_TOKEN or OPENROUTER_API_KEY",
			"judge credential missing: set OPENROUTER_API_KEY",
		]);
	});

	it("keeps unavailable provider usage as null instead of fabricating zero", () => {
		expect(sumTokenUsage([tokenUsage(3, 2, 5), unavailableTokenUsage()])).toEqual({
			prompt_tokens: null,
			completion_tokens: null,
			total_tokens: null,
		});
	});

	it("writes the minimum reproducibility manifest with a real dataset identity", async () => {
		const directory = await makeTemporaryDirectory();
		const dataset = join(directory, "fixture.json");
		const output = join(directory, "result.manifest.json");
		await writeFile(dataset, '{"fixture":true}', "utf-8");

		const manifest = await writeRunManifest(output, {
			benchmark: "fixture",
			datasetPath: dataset,
			answerer_model: "fixture-answerer",
			judge_model: "fixture-judge",
			retrieval: { strategy: "memory-search", top_k: 8 },
			resume: false,
			started_at: "2026-01-01T00:00:00.000Z",
			finished_at: "2026-01-01T00:00:01.250Z",
			token_usage: unavailableTokenUsage(),
			parameters: { quick: true },
		});

		expect(manifest.schema_version).toBe(1);
		expect(manifest.dataset.path).toBe(dataset);
		expect(manifest.dataset.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(manifest.wall_clock_ms).toBe(1_250);
		expect(manifest.token_usage.total_tokens).toBeNull();
		expect(JSON.parse(await readFile(output, "utf-8"))).toEqual(manifest);
	});
});
