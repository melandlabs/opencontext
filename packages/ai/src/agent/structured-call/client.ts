/**
 * Structured Call — single forced-tool LLM call.
 *
 * One Messages round-trip with `tool_choice` pinned to a specific tool, so
 * the host gets a machine-readable payload from a single LLM invocation.
 * Uses plain `fetch` against the Anthropic Messages wire format (no SDK) so
 * the primitive works against any compatible gateway.
 */

import { extractToolUseInput } from "./decode";

import type {
	StructuredCallContentBlock,
	StructuredCallErrorCode,
	StructuredCallOptions,
	StructuredCallResult,
	StructuredCallUsage,
} from "./types";

/** Default `max_tokens` — sized so thinking-heavy routed models still have room for the tool_use payload. */
export const DEFAULT_STRUCTURED_CALL_MAX_TOKENS = 8000;

/** Default wall-clock budget for one structured call (LLM + post-processing). */
export const DEFAULT_STRUCTURED_CALL_TIMEOUT_MS = 240_000;

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Execute a single structured (forced tool call) LLM request.
 *
 * This is the low-level primitive the higher-level `BaseAgent` adapter
 * surface does not expose: it needs `tool_choice` (and, for OpenRouter,
 * `provider.require_parameters`) on the raw wire. Native `fetch` is used
 * with no retry, equivalent to `maxRetries: 0` — callers own any retry
 * policy. Never throws: all failures come back as `ok: false` results.
 */
export async function executeStructuredCall(options: StructuredCallOptions): Promise<StructuredCallResult> {
	const {
		baseUrl,
		authToken,
		headers,
		fetchImpl = fetch,
		signal,
		model,
		system,
		user,
		tools,
		toolName,
		maxTokens = DEFAULT_STRUCTURED_CALL_MAX_TOKENS,
		timeoutMs = DEFAULT_STRUCTURED_CALL_TIMEOUT_MS,
		disableThinking = true,
		provider,
		onWarn,
	} = options;

	const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
	const body: Record<string, unknown> = {
		model,
		max_tokens: maxTokens,
		stream: false,
		system,
		messages: [{ role: "user", content: user }],
		tools,
		tool_choice: { type: "tool", name: toolName, disable_parallel_tool_use: true },
	};
	if (disableThinking) {
		body.thinking = { type: "disabled" };
	}
	if (provider) {
		body.provider = provider;
	}

	// Caller-owned signal and the timeout are combined, mirroring the
	// AbortSignal.any pattern used by the planner this was generalized from.
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let response: Response;
	let rawBody: string;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${authToken}`,
				"anthropic-version": ANTHROPIC_VERSION,
				...headers,
			},
			body: JSON.stringify(body),
			signal: requestSignal,
		});
		rawBody = await response.text();
	} catch (error) {
		return { ok: false, code: classifyTransportError(error), message: errorMessage(error) };
	}

	if (!response.ok) {
		return {
			ok: false,
			code: "http_error",
			message: httpErrorMessage(response.status, rawBody),
			status: response.status,
			errorBody: rawBody,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return {
			ok: false,
			code: "decode_error",
			message: "response body was not valid JSON",
			status: response.status,
			errorBody: rawBody,
		};
	}
	const record = asRecord(parsed);
	if (!record) {
		return {
			ok: false,
			code: "decode_error",
			message: "response body was not a JSON object",
			status: response.status,
			errorBody: rawBody,
		};
	}
	const content = record.content;
	if (!Array.isArray(content)) {
		return {
			ok: false,
			code: "decode_error",
			message: "response `content` was not an array",
			status: response.status,
			errorBody: rawBody,
		};
	}

	const extracted = extractToolUseInput(content, { toolName, onWarn });
	if (!extracted) {
		return {
			ok: false,
			code: "no_tool_use",
			message: `no "${toolName}" tool_use block or embedded JSON object found in response`,
			status: response.status,
			contentTypes: content.map((block) =>
				typeof asRecord(block)?.type === "string" ? (asRecord(block)?.type as string) : "unknown",
			),
		};
	}

	return {
		ok: true,
		content: content as StructuredCallContentBlock[],
		toolInput: extracted.input,
		source: extracted.source,
		responseModel: typeof record.model === "string" && record.model ? record.model : null,
		stopReason: typeof record.stop_reason === "string" && record.stop_reason ? record.stop_reason : null,
		usage: asRecord(record.usage) as StructuredCallUsage | undefined,
		status: response.status,
	};
}

/**
 * Map a fetch transport failure to an error code. `AbortSignal.timeout`
 * surfaces as a `TimeoutError` DOMException; a caller-aborted signal (merged
 * via `AbortSignal.any`) surfaces as `AbortError`; everything else —
 * TypeError network failures included — is a plain network error.
 */
function classifyTransportError(error: unknown): StructuredCallErrorCode {
	if (error instanceof DOMException) {
		if (error.name === "TimeoutError") return "timeout";
		if (error.name === "AbortError") return "aborted";
	}
	return "network_error";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "structured call request failed";
}

/**
 * Prefer the Anthropic error envelope `{error: {message}}` (also honored by
 * OpenRouter) and fall back to the raw body text, mirroring the image-gen
 * OpenRouter provider's error reporting.
 */
function httpErrorMessage(status: number, rawBody: string): string {
	const parsed = asRecord(safeJsonParse(rawBody));
	const apiMessage = asRecord(parsed?.error)?.message;
	if (typeof apiMessage === "string" && apiMessage) {
		return `HTTP ${status}: ${apiMessage}`;
	}
	return `structured call endpoint error ${status}${rawBody ? `: ${rawBody}` : " (empty body)"}`;
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
