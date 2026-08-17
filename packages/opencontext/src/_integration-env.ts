/**
 * Integration test helpers for memory-store reasoning primitives.
 *
 * Loaded only by `*.integration.test.ts` files, which are picked up by
 * the dedicated `vitest.integration.config.ts` and skipped automatically
 * when `OPENCONTEXT_LLM_API_KEY` is not set.
 *
 * Three responsibilities:
 *   1. Parse the repo-root `.env` into the current process (no extra
 *      dependency — vitest does not auto-load env files).
 *   2. Surface a small OpenAI-compatible chat completion client that
 *      returns the raw assistant content string, matching the
 *      `complete(prompt) => Promise<string>` shape the planner and
 *      rewriter expect.
 *   3. Provide `skipIfNoLLM()` so individual tests can guard themselves
 *      when the env is missing without failing the suite.
 */

import { promises as fs, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from `start` until a directory containing `pnpm-workspace.yaml`
 * is found. That directory is treated as the pnpm-monorepo root. Bounded
 * by the filesystem root so a broken symlink can't loop forever. Returns
 * `null` if the marker is never encountered.
 *
 * Using `pnpm-workspace.yaml` (rather than counting `..` hops) means the
 * resolver is robust to a copy-paste of this file into any package
 * subdirectory of the workspace — the hop count would silently drift, the
 * marker will not.
 */
function findRepoRoot(start: string): string | null {
	let current = path.isAbsolute(start) ? start : path.resolve(start);
	while (true) {
		const marker = path.join(current, "pnpm-workspace.yaml");
		let isMarker = false;
		try {
			isMarker = statSync(marker).isFile();
		} catch {
			isMarker = false;
		}
		if (isMarker) return current;
		const parent = path.dirname(current);
		if (parent === current) return null; // reached filesystem root
		current = parent;
	}
}

export interface LLMEnv {
	apiKey: string;
	baseUrl: string;
	model: string;
}

let envLoaded = false;
let cachedLLMEnv: LLMEnv | undefined;

/**
 * Parse the repo-root `.env` and apply it to `process.env` for any keys
 * that are not already set (system env wins). Idempotent; safe to call
 * multiple times.
 */
export async function loadRepoEnv(): Promise<void> {
	if (envLoaded) return;
	envLoaded = true;
	const here = path.dirname(fileURLToPath(import.meta.url));
	// Resolve the repo root by walking up to pnpm-workspace.yaml instead of
	// counting `..` hops, so this file is safe to copy into any package
	// subdirectory of the monorepo.
	const repoRoot = findRepoRoot(here);
	if (!repoRoot) return;
	const envPath = path.join(repoRoot, ".env");
	let raw: string;
	try {
		raw = await fs.readFile(envPath, "utf8");
	} catch {
		return;
	}
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}

export function readLLMEnv(): LLMEnv | undefined {
	if (cachedLLMEnv) return cachedLLMEnv;
	const apiKey = process.env.OPENCONTEXT_LLM_API_KEY;
	const baseUrl = process.env.OPENCONTEXT_LLM_BASE_URL;
	const model = process.env.OPENCONTEXT_LLM_MODEL;
	if (!apiKey || !baseUrl || !model) return undefined;
	cachedLLMEnv = { apiKey, baseUrl, model };
	return cachedLLMEnv;
}

/**
 * `true` when an LLM API key is available. Use this in
 * `describe.skipIf` / `it.skipIf` to keep CI green when secrets are
 * missing without making the suite flaky.
 */
export async function hasLLMEnv(): Promise<boolean> {
	await loadRepoEnv();
	return readLLMEnv() !== undefined;
}

/**
 * Throws with a descriptive message if env is missing. Use inside an
 * `it` body after the skipIf guard, as a belt-and-braces check for
 * future maintainers.
 */
export function requireLLMEnv(): LLMEnv {
	const env = readLLMEnv();
	if (!env) {
		throw new Error(
			"OPENCONTEXT_LLM_API_KEY / _BASE_URL / _MODEL not set. Copy .env.example to .env and fill in values, then run `pnpm --filter @melandlabs/memory-store test:integration`.",
		);
	}
	return env;
}

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface ChatCompletionResponse {
	choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Build a `complete(prompt) => Promise<string>` callback backed by an
 * OpenAI-compatible `/chat/completions` endpoint. Returns the raw
 * assistant content (no JSON coercion, no streaming). Matches the
 * callback shape the planner and rewriter inject, so the integration
 * tests exercise the same code path as the opencontext facade — minus
 * the AI SDK wrapper.
 */
export function createOpenAICompatibleComplete(env: LLMEnv): (prompt: string) => Promise<string> {
	const url = `${env.baseUrl.replace(/\/$/, "")}/chat/completions`;
	return async (prompt: string): Promise<string> => {
		const messages: ChatMessage[] = [{ role: "user", content: prompt }];
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${env.apiKey}`,
			},
			body: JSON.stringify({
				model: env.model,
				messages,
				temperature: 0,
			}),
		});
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`LLM ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
		}
		const json = (await response.json()) as ChatCompletionResponse;
		const content = json.choices?.[0]?.message?.content;
		if (typeof content !== "string") {
			throw new Error("LLM response missing choices[0].message.content");
		}
		return content;
	};
}

/**
 * Probe whether the configured LLM endpoint is reachable. Bounded to a
 * short timeout so a broken DNS or firewall doesn't hang the suite for
 * the full per-test budget. Returns `false` (and skips everything) when
 * the env is missing, the fetch fails, or DNS lookup times out — all of
 * which we treat as "LLM unreachable, defer this run" rather than as a
 * test failure.
 */
export async function pingLLMConnectivity(timeoutMs = 5000): Promise<boolean> {
	const env = readLLMEnv();
	if (!env) return false;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const url = `${env.baseUrl.replace(/\/$/, "")}/chat/completions`;
		// Tiny probe payload — we don't care about the response, only that
		// the TCP+TLS layer completes a request round-trip.
		await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${env.apiKey}`,
			},
			body: JSON.stringify({
				model: env.model,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
			}),
			signal: controller.signal,
		});
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}
