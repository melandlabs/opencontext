/**
 * Client for the OpenContext memory-store HTTP daemon plus the answerer LLM.
 *
 * The daemon (default http://127.0.0.1:7421, no auth) exposes:
 *   GET  /health
 *   POST /v1/raw-messages  { userId, messages[], embedOnInsert }
 *   POST /v1/search        { userId, query, limit, sources }
 *
 * The answerer LLM defaults to the Anthropic-compatible endpoint configured
 * via ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / ANSWER_MODEL (e.g. MiniMax).
 * When ANTHROPIC_AUTH_TOKEN is absent it falls back to OpenRouter
 * (OPENROUTER_API_KEY, OPENROUTER_ANSWER_MODEL).
 */

import { tokenUsage, type TokenUsage } from "../../run-support";

export const DEFAULT_OPENCONTEXT_PORT = 7421;

export function getOpencontextBaseUrl(): string {
	if (process.env.OPENCONTEXT_URL) return process.env.OPENCONTEXT_URL;
	const port = process.env.OPENCONTEXT_PORT ?? String(DEFAULT_OPENCONTEXT_PORT);
	return `http://127.0.0.1:${port}`;
}

export const BENCH_USER_ID = "benchmark_user";

export function getAnswererModelIdentity(): string {
	if (process.env.ANTHROPIC_AUTH_TOKEN) {
		return `anthropic-compatible:${process.env.ANSWER_MODEL ?? "MiniMax-M3-highspeed"}`;
	}
	return `openrouter:${process.env.OPENROUTER_ANSWER_MODEL ?? "deepseek/deepseek-chat"}`;
}

export interface GeneratedAnswer {
	text: string;
	token_usage: TokenUsage;
}

export async function checkOpencontextHealth(baseUrl = getOpencontextBaseUrl()): Promise<void> {
	let res: Response;
	try {
		res = await fetch(`${baseUrl}/health`, {
			signal: AbortSignal.timeout(5_000),
		});
	} catch (error) {
		throw new Error(`OpenContext daemon not reachable at ${baseUrl}: ${(error as Error).message}`);
	}
	if (!res.ok) {
		throw new Error(`OpenContext /health returned ${res.status}`);
	}
}

export interface BenchRawMessage {
	messageId: string;
	userId: string;
	platform: string;
	botId: string;
	timestamp: number;
	content: string;
	createdAt: number;
	metadata?: Record<string, unknown>;
}

const INGEST_BATCH_SIZE = 25;

/**
 * Ingest messages into the OpenContext memory store. `embedOnInsert: true`
 * lets the daemon fill embeddings server-side (requires it to be started
 * with an --embedding-provider).
 */
export async function ingestMessages(
	messages: BenchRawMessage[],
	baseUrl = getOpencontextBaseUrl(),
	userId = BENCH_USER_ID,
): Promise<number> {
	let inserted = 0;
	for (let i = 0; i < messages.length; i += INGEST_BATCH_SIZE) {
		const batch = messages.slice(i, i + INGEST_BATCH_SIZE).map((m) => ({
			...m,
			userId,
		}));
		const res = await fetch(`${baseUrl}/v1/raw-messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				userId,
				messages: batch,
				embedOnInsert: true,
			}),
			signal: AbortSignal.timeout(600_000),
		});
		if (!res.ok) {
			throw new Error(`ingest /v1/raw-messages failed: ${res.status} ${await res.text()}`);
		}
		const data = (await res.json()) as { count?: number };
		inserted += data.count ?? batch.length;
	}
	return inserted;
}

export interface MemorySearchHit {
	id: string;
	content: string;
	similarity: number;
	metadata: Record<string, unknown>;
}

/** Retrieve relevant memories for a question. */
export async function searchMemory(
	query: string,
	limit = 8,
	baseUrl = getOpencontextBaseUrl(),
	userId = BENCH_USER_ID,
): Promise<MemorySearchHit[]> {
	const res = await fetch(`${baseUrl}/v1/search`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			userId,
			query,
			limit,
			sources: ["memory"],
		}),
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok) {
		throw new Error(`search /v1/search failed: ${res.status} ${await res.text()}`);
	}
	const data = (await res.json()) as {
		results?: Array<{
			id: string;
			content: string;
			similarity: number;
			metadata?: Record<string, unknown>;
		}>;
	};
	return (data.results ?? []).map((r) => ({
		id: r.id,
		content: r.content,
		similarity: r.similarity,
		metadata: r.metadata ?? {},
	}));
}

/**
 * Generate an answer from the answerer LLM.
 *
 * Primary: Anthropic-compatible Messages API (MiniMax by default):
 *   ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / ANSWER_MODEL
 * Fallback: OpenRouter chat completions:
 *   OPENROUTER_API_KEY / OPENROUTER_ANSWER_MODEL (default deepseek/deepseek-chat)
 */
export async function generateAnswer(prompt: string, system?: string): Promise<GeneratedAnswer> {
	const token = process.env.ANTHROPIC_AUTH_TOKEN;
	if (token) {
		const base = (process.env.ANTHROPIC_BASE_URL ?? "https://api.minimaxi.com/anthropic").replace(/\/+$/, "");
		const model = process.env.ANSWER_MODEL ?? "MiniMax-M3-highspeed";
		const res = await fetch(`${base}/v1/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model,
				max_tokens: 4096,
				...(system ? { system } : {}),
				messages: [{ role: "user", content: prompt }],
			}),
			signal: AbortSignal.timeout(600_000),
		});
		if (!res.ok) {
			throw new Error(`answerer LLM error: ${res.status} ${await res.text()}`);
		}
		const data = (await res.json()) as {
			content?: Array<{ type: string; text?: string }>;
			usage?: { input_tokens?: number; output_tokens?: number };
		};
		const text = (data.content ?? [])
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text as string)
			.join("");
		return {
			text,
			token_usage: tokenUsage(data.usage?.input_tokens, data.usage?.output_tokens, undefined),
		};
	}

	const openrouterKey = process.env.OPENROUTER_API_KEY;
	if (!openrouterKey) {
		throw new Error("No answerer LLM configured: set ANTHROPIC_AUTH_TOKEN (MiniMax) or OPENROUTER_API_KEY.");
	}
	const { generateText } = await import("ai");
	const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
	const openrouter = createOpenAICompatible({
		baseURL: "https://openrouter.ai/api/v1",
		apiKey: openrouterKey,
		name: "openrouter",
	});
	const { text, usage } = await generateText({
		model: openrouter(process.env.OPENROUTER_ANSWER_MODEL ?? "deepseek/deepseek-chat"),
		...(system ? { system } : {}),
		prompt,
	});
	return {
		text,
		token_usage: tokenUsage(usage.inputTokens, usage.outputTokens, usage.totalTokens),
	};
}
