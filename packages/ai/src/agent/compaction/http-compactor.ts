import { type CompactionLevel, buildCompactionPrompt } from "./compaction";
/**
 * HTTP-first compaction client for `BaseAgent.compactContext`.
 *
 * When `providerConfig.compactor` is NOT configured, `BaseAgent.compactContext`
 * resolves an HTTP endpoint (per-call override → `providerConfig.compactionEndpoint`
 * → `process.env.COMPACTION_HTTP_ENDPOINT`) and POSTs the conversation to
 * it via this helper.
 *
 * Two request shapes are supported, selected by `protocol`:
 *
 * - `protocol: "anthropic"` (default) — Anthropic Messages API:
 *
 *     POST {baseUrl}/v1/messages
 *     Content-Type: application/json
 *     anthropic-version: 2023-06-01
 *     Authorization: Bearer <userToken>            (when userToken is set)
 *     <…caller-supplied headers via compactionEndpoint.headers / extraHeaders>
 *     {
 *       "model": "...",
 *       "system": "<buildCompactionPrompt(level)>",
 *       "messages": [{ "role": "user"|"assistant"|"system", "content": "..." }, ...],
 *       "max_tokens": 2000
 *     }
 *
 *     Response:
 *     {
 *       "content": [{ "type": "text", "text": "..." }, ...],
 *       "usage": { "input_tokens": N, "output_tokens": M },
 *       "stop_reason": "..."
 *     }
 *
 * - `protocol: "openai"` — OpenAI-compatible Chat Completions API:
 *
 *     POST {baseUrl}/v1/chat/completions
 *     Content-Type: application/json
 *     Authorization: Bearer <userToken>            (when userToken is set)
 *     <…caller-supplied headers via compactionEndpoint.headers / extraHeaders>
 *     {
 *       "model": "...",
 *       "messages": [
 *         { "role": "system", "content": "<buildCompactionPrompt(level)>" },
 *         { "role": "user"|"assistant", "content": "..." }, ...
 *       ],
 *       "max_tokens": 2000
 *     }
 *
 *     Response:
 *     {
 *       "choices": [{ "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }, ...],
 *       "usage": { "prompt_tokens": N, "completion_tokens": M }
 *     }
 *
 * In both cases the resulting text becomes `CompactContextResult.summary`,
 * with `usage.*_tokens` mapped through to `originalTokens` / `summaryTokens`.
 *
 * No host-specific header (e.g. usage-task attribution) is set here; callers
 * attach everything they need via `compactionEndpoint.headers` (agent-level)
 * or `extraHeaders` (per-call). Resolution and defaults are owned by
 * {@link BaseAgent.compactContext}.
 */
import type { CompactContextInput, CompactContextResult } from "./compactor";

/**
 * Wire protocol the resolved endpoint speaks.
 *
 * `"anthropic"` → POST {baseUrl}/v1/messages with a `system` field,
 * `anthropic-version` header, and `content[]` response.
 * `"openai"`     → POST {baseUrl}/v1/chat/completions with a leading
 * `system` message in `messages[]`, and `choices[].message.content`
 * response.
 */
export type HttpCompactorProtocol = "anthropic" | "openai";

/** Resolved configuration for a single HTTP compaction call. */
export interface HttpCompactorResolved {
	endpoint: string;
	/** Per-call user bearer token (already resolved by the caller). */
	userToken?: string;
	/** Model id to declare in the request body. */
	model: string;
	/** Headers contributed by `providerConfig.compactionEndpoint.headers`. */
	baseHeaders: Record<string, string>;
	/** Wire protocol — default `"anthropic"`. */
	protocol?: HttpCompactorProtocol;
	/** Abort signal for cancellation. */
	signal?: AbortSignal;
}

/**
 * Default Anthropic API version header — matches what `anthropic-version`
 * the v1 Messages route expects. Hosts can override via
 * `providerConfig.compactionEndpoint.headers`.
 */
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/**
 * Default model id when neither the per-call input nor the agent-level
 * configuration supplies one. Hosts can override via
 * `providerConfig.compactionEndpoint.model` (resolved by the caller).
 */
const DEFAULT_COMPACTION_MODEL = "claude-haiku-4-5";

/**
 * Default hard cap on the generated summary. The compaction prompt asks
 * for ≤1500 tokens; this bounds cost even if the model ignores that
 * instruction. Same default as `runCompactor` keeps parity between the
 * in-process and HTTP paths.
 */
const DEFAULT_MAX_SUMMARY_TOKENS = 2000;

/** Default protocol when neither the per-call input nor the agent-level configuration supplies one. */
const DEFAULT_PROTOCOL: HttpCompactorProtocol = "anthropic";

/**
 * Sanitize messages into the Anthropic wire shape.
 *
 *   - Roles are coerced to `user` | `assistant` | `system` (anything else
 *     is treated as `assistant`, matching the `runCompactor` convention so
 *     older call sites that pass tool-ish role strings still work).
 *   - Empty / non-string content is replaced with an empty string so the
 *     request body is always valid JSON.
 */
function toAnthropicMessages(
	messages: CompactContextInput["messages"],
): Array<{ role: "user" | "assistant" | "system"; content: string }> {
	return messages.map((m) => ({
		role: normalizeRole(m.role),
		content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
	}));
}

/**
 * Sanitize messages into the OpenAI Chat Completions wire shape.
 *
 *   - OpenAI expects `role: "user" | "assistant" | "system" | "tool"`; we
 *     coerce anything else to `"assistant"` for parity with the Anthropic
 *     path.
 *   - Empty / non-string content is replaced with an empty string.
 *   - The compaction system prompt is prepended as the first message so the
 *     summarizer still sees the same instructions — OpenAI does NOT have a
 *     separate `system` field the way Anthropic does.
 */
function toOpenAIMessages(
	messages: CompactContextInput["messages"],
	systemPrompt: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
	return [
		{ role: "system", content: systemPrompt },
		...messages.map((m) => ({
			role: normalizeOpenAIRole(m.role),
			content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
		})),
	];
}

function normalizeRole(role: "user" | "assistant" | "system"): "user" | "assistant" | "system" {
	if (role === "user" || role === "system") {
		return role;
	}
	return "assistant";
}

function normalizeOpenAIRole(role: "user" | "assistant" | "system"): "user" | "assistant" | "system" {
	// Same coercion as the Anthropic path — `tool` (and anything unexpected)
	// becomes `assistant` so older call sites that pass tool-ish role strings
	// still work.
	if (role === "user" || role === "system") {
		return role;
	}
	return "assistant";
}

/**
 * Merge caller-supplied headers on top of the protocol-specific defaults.
 * Order (matching the JSDoc contract on {@link CompactContextInput.extraHeaders}):
 *   1. protocol defaults (Content-Type, anthropic-version, etc.)
 *   2. `compactionEndpoint.headers` (agent-level)
 *   3. `Authorization: Bearer <userToken>` (when set)
 *   4. `input.extraHeaders` (per-call, LAST — can override anything above)
 */
function buildHeaders(
	resolved: HttpCompactorResolved,
	input: CompactContextInput,
	protocol: HttpCompactorProtocol,
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...(protocol === "anthropic" ? { "anthropic-version": DEFAULT_ANTHROPIC_VERSION } : {}),
		...resolved.baseHeaders,
	};
	if (resolved.userToken) {
		headers.Authorization = `Bearer ${resolved.userToken}`;
	}
	if (input.extraHeaders) {
		Object.assign(headers, input.extraHeaders);
	}
	return headers;
}

/**
 * POST the supplied conversation to the resolved HTTP endpoint and parse
 * the response into a {@link CompactContextResult}. The wire shape is
 * selected by `resolved.protocol` — see this file's header for the two
 * request/response contracts.
 *
 * Failure modes (all thrown so the caller can decide how to surface them):
 *   - Network / DNS failure: bubbles up from `fetch`.
 *   - Non-2xx HTTP status: `Error("compactContext HTTP <status>: <body>")`
 *     (body truncated to 500 chars to keep error messages readable).
 *   - Malformed response (no text content): typed Error.
 *
 * Caller is expected to have validated the messages list — this helper does
 * NOT short-circuit on empty input, matching `runCompactor`'s strict
 * posture (an empty conversation is a bug at the call site).
 */
export async function compactContextHttp(
	input: CompactContextInput,
	resolved: HttpCompactorResolved,
): Promise<CompactContextResult> {
	const protocol = resolved.protocol ?? DEFAULT_PROTOCOL;
	return protocol === "openai"
		? compactContextHttpOpenAI(input, resolved)
		: compactContextHttpAnthropic(input, resolved);
}

async function compactContextHttpAnthropic(
	input: CompactContextInput,
	resolved: HttpCompactorResolved,
): Promise<CompactContextResult> {
	const level: CompactionLevel = input.level ?? "soft";
	const maxTokens = input.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;
	const model = resolved.model || DEFAULT_COMPACTION_MODEL;

	const body = {
		model,
		max_tokens: maxTokens,
		system: buildCompactionPrompt(level),
		messages: toAnthropicMessages(input.messages),
	};

	const headers = buildHeaders(resolved, input, "anthropic");

	const response = await fetch(resolved.endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: resolved.signal,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`compactContext HTTP ${response.status}: ${text.slice(0, 500)}`);
	}

	const data = (await response.json()) as {
		content?: Array<{ type: string; text?: string }>;
		usage?: { input_tokens?: number; output_tokens?: number };
		stop_reason?: string;
	};
	const textBlock = data.content?.find((c) => c.type === "text");
	if (!textBlock?.text) {
		throw new Error("compactContext HTTP response missing text content");
	}

	return {
		summary: textBlock.text,
		messageCount: input.messages.length,
		level,
		originalTokens: data.usage?.input_tokens ?? 0,
		summaryTokens: data.usage?.output_tokens ?? 0,
	};
}

async function compactContextHttpOpenAI(
	input: CompactContextInput,
	resolved: HttpCompactorResolved,
): Promise<CompactContextResult> {
	const level: CompactionLevel = input.level ?? "soft";
	const maxTokens = input.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;
	const model = resolved.model || DEFAULT_COMPACTION_MODEL;
	const systemPrompt = buildCompactionPrompt(level);

	const body = {
		model,
		max_tokens: maxTokens,
		messages: toOpenAIMessages(input.messages, systemPrompt),
	};

	const headers = buildHeaders(resolved, input, "openai");

	const response = await fetch(resolved.endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: resolved.signal,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`compactContext HTTP ${response.status}: ${text.slice(0, 500)}`);
	}

	const data = (await response.json()) as {
		choices?: Array<{
			message?: { role?: string; content?: string };
			finish_reason?: string;
		}>;
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	const firstChoice = data.choices?.[0];
	const content = firstChoice?.message?.content;
	if (typeof content !== "string" || content.length === 0) {
		throw new Error("compactContext HTTP response missing text content");
	}

	return {
		summary: content,
		messageCount: input.messages.length,
		level,
		originalTokens: data.usage?.prompt_tokens ?? 0,
		summaryTokens: data.usage?.completion_tokens ?? 0,
	};
}
