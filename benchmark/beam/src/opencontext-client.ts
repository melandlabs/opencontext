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

import { type TokenUsage, tokenUsage } from "../../run-support";

export const DEFAULT_OPENCONTEXT_PORT = 7421;
const MODEL_REQUEST_TIMEOUT_MS = 300_000;

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

export const INGEST_BATCH_SIZE = 25;

export interface IngestMessagesResult {
	inserted: number;
	warnings: unknown[];
	batches: IngestBatchTrace[];
}

export interface IngestBatchTrace {
	batch_index: number;
	message_ids: string[];
	requested: number;
	inserted: number;
	status: "completed" | "partial" | "execution_error";
	latency_ms: number;
	warnings: unknown[];
	error?: string;
}

export class IngestMessagesError extends Error {
	constructor(
		message: string,
		readonly result: IngestMessagesResult,
	) {
		super(message);
		this.name = "IngestMessagesError";
	}
}

/**
 * Ingest messages into the OpenContext memory store. `embedOnInsert: true`
 * lets the daemon fill embeddings server-side (requires it to be started
 * with an --embedding-provider).
 */
export async function ingestMessages(
	messages: BenchRawMessage[],
	baseUrl = getOpencontextBaseUrl(),
	userId = BENCH_USER_ID,
): Promise<IngestMessagesResult> {
	let inserted = 0;
	const warnings: unknown[] = [];
	const batches: IngestBatchTrace[] = [];
	for (let i = 0; i < messages.length; i += INGEST_BATCH_SIZE) {
		const batch = messages.slice(i, i + INGEST_BATCH_SIZE).map((m) => ({
			...m,
			userId,
		}));
		const batchIndex = i / INGEST_BATCH_SIZE;
		const startedAt = performance.now();
		try {
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
			const data = (await res.json()) as { count?: number; warnings?: unknown[] };
			const batchInserted = data.count ?? batch.length;
			const batchWarnings = data.warnings ?? [];
			inserted += batchInserted;
			warnings.push(...batchWarnings);
			const status = batchInserted === batch.length ? "completed" : "partial";
			batches.push({
				batch_index: batchIndex,
				message_ids: batch.map((message) => message.messageId),
				requested: batch.length,
				inserted: batchInserted,
				status,
				latency_ms: Math.round(performance.now() - startedAt),
				warnings: batchWarnings,
			});
			if (status === "partial") {
				throw new IngestMessagesError(
					`ingest inserted ${batchInserted} of ${batch.length} messages in batch ${batchIndex}`,
					{ inserted, warnings, batches },
				);
			}
		} catch (error) {
			if (error instanceof IngestMessagesError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			batches.push({
				batch_index: batchIndex,
				message_ids: batch.map((item) => item.messageId),
				requested: batch.length,
				inserted: 0,
				status: "execution_error",
				latency_ms: Math.round(performance.now() - startedAt),
				warnings: [],
				error: message,
			});
			throw new IngestMessagesError(message, { inserted, warnings, batches });
		}
	}
	return { inserted, warnings, batches };
}

export interface MemorySearchHit {
	id: string;
	content: string;
	similarity: number;
	metadata: Record<string, unknown>;
	signals?: Record<string, unknown>;
}

export interface MemorySearchEvidence {
	id: string;
	snippet: string;
	score: number;
	originalCharacters?: number;
	startCharacter?: number;
	endCharacter?: number;
	truncated?: boolean;
}

export interface MemorySearchResponse {
	query: string;
	sources: string[];
	results: MemorySearchHit[];
	evidence?: MemorySearchEvidence[];
	count: number;
	warnings: unknown[];
	reasoning?: unknown;
	retrievalDiagnostics?: {
		mergeStrategy: "rrf" | "similarity";
		candidateLimit: number;
		backend?: string;
		semanticDegradedReason?: string;
		candidateCounts?: {
			semantic: number;
			lexical: number;
			hybrid: number;
			entity: number;
			fused: number;
			final: number;
		};
		channels: {
			semantic: MemorySearchHit[];
			lexical: MemorySearchHit[];
			hybrid?: MemorySearchHit[];
			entity?: MemorySearchHit[];
		};
		fusedBeforeRerank: MemorySearchHit[];
		reranker?: {
			enabled: boolean;
			provider?: string;
			model?: string;
			inputCount: number;
			outputCount: number;
			latencyMs: number;
			orderChanged: boolean;
		};
		final?: MemorySearchHit[];
	};
}

export interface MemorySearchOptions {
	includeRetrievalDiagnostics?: boolean;
}

/** Retrieve relevant memories for a question. */
export async function searchMemory(
	query: string,
	limit = 8,
	baseUrl = getOpencontextBaseUrl(),
	userId = BENCH_USER_ID,
	options: MemorySearchOptions = {},
): Promise<MemorySearchResponse> {
	const res = await fetch(`${baseUrl}/v1/search`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			userId,
			query,
			limit,
			...(options.includeRetrievalDiagnostics === undefined
				? {}
				: { includeRetrievalDiagnostics: options.includeRetrievalDiagnostics }),
			sources: ["memory"],
		}),
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok) {
		throw new Error(`search /v1/search failed: ${res.status} ${await res.text()}`);
	}
	const data = (await res.json()) as {
		query?: string;
		sources?: string[];
		count?: number;
		warnings?: unknown[];
		reasoning?: unknown;
		retrievalDiagnostics?: MemorySearchResponse["retrievalDiagnostics"];
		evidence?: MemorySearchEvidence[];
		results?: Array<{
			id: string;
			content: string;
			similarity: number;
			metadata?: Record<string, unknown>;
			signals?: Record<string, unknown>;
		}>;
	};
	const results = (data.results ?? []).map((r) => ({
		id: r.id,
		content: r.content,
		similarity: r.similarity,
		metadata: r.metadata ?? {},
		...(r.signals ? { signals: r.signals } : {}),
	}));
	return {
		query: data.query ?? query,
		sources: data.sources ?? [],
		results,
		evidence: data.evidence ?? [],
		count: data.count ?? results.length,
		warnings: data.warnings ?? [],
		...(data.reasoning === undefined ? {} : { reasoning: data.reasoning }),
		...(data.retrievalDiagnostics === undefined ? {} : { retrievalDiagnostics: data.retrievalDiagnostics }),
	};
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
		abortSignal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
	});
	return {
		text,
		token_usage: tokenUsage(usage.inputTokens, usage.outputTokens, usage.totalTokens),
	};
}
