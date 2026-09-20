/**
 * In-process compactor for {@link IAgent.compactContext}.
 *
 * This is the lighter, model-agnostic counterpart to {@link triggerCompaction}:
 * the caller hands in a fully-resolved {@link LanguageModel} (typically built
 * once via `createCompactor(...)` from `@melandlabs/opencontext`) and we run
 * `generateText` against it. No hardcoded HTTP endpoint, no hardcoded model id.
 *
 * Behavioural contract differences vs `triggerCompaction`:
 *   - Throws on `generateText` rejection (silent `null` would hide bugs in an
 *     in-process LLM call where the caller can recover / retry). The standalone
 *     HTTP client can stay silent because it is fire-and-forget from the agent
 *     loop and cannot usefully be retried at that layer.
 *   - Result is non-nullable. `CompactionResult` is reused structurally with
 *     `level` always populated by the caller-supplied input.
 */
import { type LanguageModel, generateText } from "ai";

import { type CompactionPreprocessOptions, sanitizeCompactionMessages } from "../compaction-preprocess";
import { type CompactionLevel, buildCompactionPrompt } from "./compaction";
import { isContextOverflowError } from "./overflow";

export interface CompactContextInput {
	/** Conversation messages to summarize, oldest first. */
	messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
	/** Compaction aggressiveness. Defaults to `"soft"`. */
	level?: CompactionLevel;
	/** Optional override for the preprocessing bounds. */
	preprocessOptions?: CompactionPreprocessOptions;
	/**
	 * Hard cap on the summary length (passed to `generateText` as
	 * `maxOutputTokens`). The compaction prompt already asks for ≤1500
	 * tokens; this bounds cost even if the model ignores the instruction.
	 * Defaults to 2000 when neither input nor options supply a value.
	 */
	maxSummaryTokens?: number;
}

export interface CompactContextResult {
	/** The generated summary text. */
	summary: string;
	/** Number of messages that reached the summarizer after sanitization. */
	messageCount: number;
	/** The compaction level used (resolved from input.defaulted to `"soft"`). */
	level: CompactionLevel;
	/** Input tokens reported by the summarizer call. Includes the compaction
	 * system prompt, so it is larger than the messages alone; 0 when the
	 * provider does not report usage. */
	originalTokens: number;
	/** Token count of the generated summary. */
	summaryTokens: number;
}

export interface Compactor {
	compact(input: CompactContextInput): Promise<CompactContextResult>;
}

export interface RunCompactorOptions {
	timeoutMs?: number;
	preprocessOptions?: CompactionPreprocessOptions;
	/**
	 * Fallback cap on the summary length when the input does not carry
	 * `maxSummaryTokens`. See {@link CompactContextInput.maxSummaryTokens}.
	 */
	maxSummaryTokens?: number;
	/**
	 * Number of times to retry the summarizer call after dropping the
	 * oldest messages when the call itself fails with a context-overflow
	 * error (the input history can exceed the summarizer's own window).
	 * Each retry drops roughly the oldest quarter of the remaining
	 * messages. Defaults to 2. Set 0 to disable.
	 */
	overflowDropRetries?: number;
}

/** Default cap for the generated summary (the prompt asks for ≤1500). */
const DEFAULT_MAX_SUMMARY_TOKENS = 2000;

/**
 * Run a single compaction pass against the supplied model.
 *
 * Steps:
 *   1. Reject empty input before doing any LLM work.
 *   2. `sanitizeCompactionMessages` strips media payloads / oversized code so
 *      the summarizer sees a sane payload. Roles are coerced via the same
 *      "user / system / everything else is assistant" rule used by
 *      `triggerCompaction`, so older call sites that pass tool-ish role strings
 *      still work.
 *   3. If sanitization drops everything (e.g. only media-only messages were
 *      supplied), bail with a typed error before paying for an LLM call.
 *   4. `buildCompactionPrompt(level)` produces the summary system prompt.
 *   5. `generateText` with `temperature: 0` and an optional abort signal.
 *   6. Token counts are pulled from `result.usage.inputTokens` /
 *      `result.usage.outputTokens` (AI SDK v5 shape; older callers / providers
 *      may report `undefined`, in which case we fall back to `0`).
 */
export async function runCompactor(
	model: LanguageModel,
	input: CompactContextInput,
	options: RunCompactorOptions = {},
): Promise<CompactContextResult> {
	if (!input.messages || input.messages.length === 0) {
		throw new Error("compactContext: no messages supplied");
	}

	const level: CompactionLevel = input.level ?? "soft";
	const preprocessOptions = input.preprocessOptions ?? options.preprocessOptions;
	const maxOutputTokens = input.maxSummaryTokens ?? options.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;
	const overflowDropRetries = Math.max(0, options.overflowDropRetries ?? 2);

	const controller = new AbortController();
	const timeoutMs = options.timeoutMs ?? 30_000;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();

	try {
		// The input history can be larger than the summarizer's own context
		// window. When the summarizer call fails with an overflow-shaped
		// error, drop the oldest quarter and retry (Codex CLI precedent) —
		// older turns carry the least task-relevant detail anyway.
		let messages = input.messages.map((message) => ({
			role: normalizeCompactionRole(message.role),
			content: message.content,
		}));
		let lastError: unknown;
		for (let attempt = 0; attempt <= overflowDropRetries; attempt += 1) {
			const sanitized = sanitizeCompactionMessages(
				messages.map(({ role, content }) => ({ role, type: "message" as const, content })),
				preprocessOptions,
			);
			const compactionMessages = sanitized.map(({ role, content }) => ({ role, content }));

			if (compactionMessages.length === 0) {
				throw new Error("compactContext: no messages left after sanitization");
			}

			const systemPrompt = buildCompactionPrompt(level);
			try {
				const result = await generateText({
					model,
					system: systemPrompt,
					messages: compactionMessages,
					temperature: 0,
					maxOutputTokens,
					abortSignal: controller.signal,
				});

				const usage = result.usage ?? {};
				return {
					summary: result.text,
					messageCount: compactionMessages.length,
					level,
					originalTokens: usage.inputTokens ?? 0,
					summaryTokens: usage.outputTokens ?? 0,
				};
			} catch (error) {
				lastError = error;
				const canRetry =
					attempt < overflowDropRetries && isContextOverflowError(error) && compactionMessages.length > 1;
				if (!canRetry) {
					throw error;
				}
				// Drop the oldest quarter (at least one message) and retry.
				const dropCount = Math.max(1, Math.floor(compactionMessages.length / 4));
				messages = compactionMessages.slice(dropCount);
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	} finally {
		clearTimeout(timer);
	}
}

function normalizeCompactionRole(role: "user" | "assistant" | "system"): "user" | "assistant" | "system" {
	// Caller already constrains the input type, but be defensive in case future
	// call sites widen the role union. Match the `triggerCompaction` convention.
	if (role === "user" || role === "system") {
		return role;
	}
	return "assistant";
}
