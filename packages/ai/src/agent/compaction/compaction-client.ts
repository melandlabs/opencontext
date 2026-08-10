/**
 * Compaction Client
 *
 * Calls /api/ai/v1/chat/completions to summarize old conversation messages.
 * The chat route handles credit billing and proxies to cloud in native mode.
 *
 * Fire-and-forget: compaction runs asynchronously; errors are logged but
 * do not block the main message processing flow.
 */
import { sanitizeCompactionMessages } from "../compaction-preprocess";

import {
	COMPACTION_MODEL,
	type CompactionLevel,
	type CompactionPlatform,
	buildCompactionPrompt,
} from "./compaction";

/**
 * Result returned by compaction.
 */
export interface CompactionResponse {
	summary: string;
	messageCount: number;
	level: CompactionLevel;
	originalTokens: number;
	summaryTokens: number;
	creditsUsed: number;
}

/**
 * Options for triggering compaction.
 */
export interface CompactionOptions {
	/** Messages to summarize (oldest first) */
	messages: Array<{ role: string; content: string }>;
	/** Compaction level */
	level: CompactionLevel;
	/** Platform name */
	platform: CompactionPlatform;
	/** Auth token (Bearer token for /api/ai/v1/chat/completions) */
	authToken: string;
}

function normalizeCompactionRole(role: string): "user" | "assistant" | "system" {
	// Older call sites may still pass tool/system-ish roles as plain strings.
	if (role === "user" || role === "system") {
		return role;
	}
	return "assistant";
}

/**
 * Trigger conversation compaction via /api/ai/v1/chat/completions.
 * The chat route handles credit billing and proxies to cloud in native mode.
 *
 * @param options - Compaction options
 * @returns CompactionResponse | null - Summary result or null on failure
 */
export async function triggerCompaction(options: CompactionOptions): Promise<CompactionResponse | null> {
	const { messages, level, platform, authToken } = options;

	if (!messages || messages.length === 0) {
		return null;
	}

	// The client keeps a last-line sanitize pass so oversized code blocks,
	// media payloads, or other noisy content do not reach the summarizer even
	// when callers skip richer preprocessing.
	const sanitizedMessages = sanitizeCompactionMessages(
		messages.map(({ role, content }) => ({
			role: normalizeCompactionRole(role),
			type: "message" as const,
			content,
		})),
	);
	const compactionMessages = sanitizedMessages.map(({ role, content }) => ({
		role,
		content,
	}));

	// Sanitization can legally drop empty/noisy payloads, so bail out before
	// paying for a summarization request that would carry no useful history.
	if (compactionMessages.length === 0) {
		return null;
	}

	const systemPrompt = buildCompactionPrompt(level);

	try {
		const response = await fetch("/api/ai/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${authToken}`,
			},
			body: JSON.stringify({
				messages: compactionMessages,
				model: COMPACTION_MODEL,
				system: systemPrompt,
				stream: false,
			}),
		});

		if (!response.ok) {
			const _errorBody = await response.json().catch(() => ({}));
			if (response.status === 402) {
			}
			return null;
		}

		const data = await response.json();

		return {
			summary: data.text || "",
			messageCount: compactionMessages.length,
			level,
			originalTokens: data.usage?.inputTokens || 0,
			summaryTokens: data.usage?.outputTokens || 0,
			creditsUsed: data.usage?.totalCredits || 0,
		};
	} catch (_error) {
		return null;
	}
}

/**
 * Fire-and-forget compaction wrapper that persists the summary to per-day files
 * on success. This is called after trimming conversation history; it summarizes
 * the dropped messages and writes the summary back so future history calls see it.
 *
 * @param options - Compaction options including persistSummary callback
 */
export async function triggerCompactionAsync(
	options: CompactionOptions & {
		/**
		 * Called on success with the summary result and the original messages.
		 * Implementations should call saveCompactionSummary to write the summary
		 * back to per-day files.
		 */
		persistSummary: (
			result: CompactionResponse,
			messages: Array<{ role: string; content: string }>,
		) => void | Promise<void>;
	},
): Promise<void> {
	const { persistSummary, ...compactionOptions } = options;
	// persistSummary can write to DB or file-backed stores, so we await it here
	// to surface persistence failures in the compaction log path.
	const result = await triggerCompaction(compactionOptions);
	if (!result) {
		return;
	}
	try {
		await persistSummary(result, options.messages);
	} catch (_err) {}
}
