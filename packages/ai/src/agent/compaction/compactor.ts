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

export interface CompactContextInput {
	/** Conversation messages to summarize, oldest first. */
	messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
	/** Compaction aggressiveness. Defaults to `"soft"`. */
	level?: CompactionLevel;
	/** Optional override for the preprocessing bounds. */
	preprocessOptions?: CompactionPreprocessOptions;
}

export interface CompactContextResult {
	/** The generated summary text. */
	summary: string;
	/** Number of messages that reached the summarizer after sanitization. */
	messageCount: number;
	/** The compaction level used (resolved from input.defaulted to `"soft"`). */
	level: CompactionLevel;
	/** Token count of the (sanitized) messages the summarizer saw. */
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
}

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

	const sanitized = sanitizeCompactionMessages(
		input.messages.map((message) => ({
			role: normalizeCompactionRole(message.role),
			type: "message" as const,
			content: message.content,
		})),
		preprocessOptions,
	);
	const compactionMessages = sanitized.map(({ role, content }) => ({ role, content }));

	if (compactionMessages.length === 0) {
		throw new Error("compactContext: no messages left after sanitization");
	}

	const controller = new AbortController();
	const timeoutMs = options.timeoutMs ?? 30_000;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();

	const systemPrompt = buildCompactionPrompt(level);

	try {
		const result = await generateText({
			model,
			system: systemPrompt,
			messages: compactionMessages,
			temperature: 0,
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
