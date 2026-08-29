import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const MAX_HASH_BYTES = 256 * 1024 * 1024;

export interface TokenUsage {
	prompt_tokens: number | null;
	completion_tokens: number | null;
	total_tokens: number | null;
}

export interface DatasetIdentity {
	path: string;
	size_bytes: number;
	mtime_ms: number;
	sha256: string | null;
}

export interface RunManifest {
	schema_version: 1;
	benchmark: string;
	git_commit: string | null;
	dataset: DatasetIdentity;
	answerer_model: string;
	judge_model: string;
	retrieval: { strategy: string; top_k: number };
	resume: boolean;
	started_at: string;
	finished_at: string;
	wall_clock_ms: number;
	token_usage: TokenUsage;
	parameters: Record<string, unknown>;
}

interface PreflightOptions {
	datasetPath: string;
	writablePaths: string[];
	parameterErrors: string[];
	validateDataset: () => Promise<void>;
	checkDaemon: () => Promise<void>;
}

export function unavailableTokenUsage(): TokenUsage {
	return { prompt_tokens: null, completion_tokens: null, total_tokens: null };
}

export function zeroTokenUsage(): TokenUsage {
	return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

export function tokenUsage(
	promptTokens: number | undefined,
	completionTokens: number | undefined,
	totalTokens: number | undefined,
): TokenUsage {
	const prompt = promptTokens ?? null;
	const completion = completionTokens ?? null;
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: totalTokens ?? (prompt !== null && completion !== null ? prompt + completion : null),
	};
}

export function sumTokenUsage(usages: Array<TokenUsage | undefined>): TokenUsage {
	if (usages.length === 0) return zeroTokenUsage();
	const sum = (key: keyof TokenUsage): number | null => {
		const values = usages.map((usage) => usage?.[key] ?? null);
		return values.some((value) => value === null)
			? null
			: (values as number[]).reduce((total, value) => total + value, 0);
	};
	return {
		prompt_tokens: sum("prompt_tokens"),
		completion_tokens: sum("completion_tokens"),
		total_tokens: sum("total_tokens"),
	};
}

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export async function getDatasetIdentity(path: string): Promise<DatasetIdentity> {
	const absolutePath = resolve(path);
	const info = await stat(absolutePath);
	return {
		path: absolutePath,
		size_bytes: info.size,
		mtime_ms: info.mtimeMs,
		sha256: info.size <= MAX_HASH_BYTES ? await sha256(absolutePath) : null,
	};
}

function getGitCommit(): string | null {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim() || null;
	} catch {
		return null;
	}
}

async function checkWritablePath(path: string): Promise<void> {
	const absolutePath = resolve(path);
	try {
		const info = await stat(absolutePath);
		if (info.isDirectory()) throw new Error(`expected a file path but found a directory: ${absolutePath}`);
		await access(absolutePath, constants.W_OK);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	let candidate = dirname(absolutePath);
	while (true) {
		try {
			await access(candidate, constants.W_OK);
			return;
		} catch {
			const parent = dirname(candidate);
			if (parent === candidate) throw new Error(`no writable parent directory for ${path}`);
			candidate = parent;
		}
	}
}

export async function collectPreflightErrors(options: PreflightOptions): Promise<string[]> {
	const errors = [...options.parameterErrors];
	let datasetReadable = true;
	try {
		await access(resolve(options.datasetPath), constants.R_OK);
	} catch {
		datasetReadable = false;
		errors.push(`dataset is missing or unreadable: ${resolve(options.datasetPath)}`);
	}
	if (datasetReadable) {
		try {
			await options.validateDataset();
		} catch (error) {
			errors.push(`dataset validation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	try {
		await options.checkDaemon();
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.OPENROUTER_API_KEY) {
		errors.push("answerer credential missing: set ANTHROPIC_AUTH_TOKEN or OPENROUTER_API_KEY");
	}
	if (!process.env.OPENROUTER_API_KEY) {
		errors.push("judge credential missing: set OPENROUTER_API_KEY");
	}
	for (const path of [...new Set(options.writablePaths)]) {
		try {
			await checkWritablePath(path);
		} catch (error) {
			errors.push(
				`output/checkpoint path is not writable: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return errors;
}

export async function runPreflight(options: PreflightOptions): Promise<void> {
	const errors = await collectPreflightErrors(options);
	if (errors.length > 0)
		throw new Error(`Benchmark preflight failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

export function getManifestPath(output: string | undefined, benchmarkDir: string, startedAt: string): string {
	if (output) return `${output}.manifest.json`;
	const stamp = startedAt.replace(/[:.]/g, "-");
	return join(benchmarkDir, "results", `run-${stamp}.manifest.json`);
}

export async function writeRunManifest(
	path: string,
	input: Omit<RunManifest, "schema_version" | "git_commit" | "dataset" | "wall_clock_ms"> & {
		datasetPath: string;
	},
): Promise<RunManifest> {
	const started = Date.parse(input.started_at);
	const finished = Date.parse(input.finished_at);
	const manifest: RunManifest = {
		schema_version: 1,
		benchmark: input.benchmark,
		git_commit: getGitCommit(),
		dataset: await getDatasetIdentity(input.datasetPath),
		answerer_model: input.answerer_model,
		judge_model: input.judge_model,
		retrieval: input.retrieval,
		resume: input.resume,
		started_at: input.started_at,
		finished_at: input.finished_at,
		wall_clock_ms: Math.max(0, finished - started),
		token_usage: input.token_usage,
		parameters: input.parameters,
	};
	await mkdir(dirname(resolve(path)), { recursive: true });
	await writeFile(path, JSON.stringify(manifest, null, 2), "utf-8");
	return manifest;
}
