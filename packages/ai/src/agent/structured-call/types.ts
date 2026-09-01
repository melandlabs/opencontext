/**
 * Structured Call — shared request/response types.
 *
 * A "structured call" is a single LLM round-trip where the model is forced
 * (via `tool_choice`) to emit one specific tool call, so the host gets a
 * machine-readable payload instead of free-form text. The wire format is the
 * Anthropic Messages API; gateways that speak it (Anthropic, OpenRouter,
 * Bedrock-fronted proxies) are all valid targets.
 */

/** Tool descriptor forwarded verbatim to the Messages API `tools` field. */
export interface StructuredCallTool {
	name: string;
	description?: string;
	input_schema: Record<string, unknown>;
	[key: string]: unknown;
}

/**
 * Wire shape of an Anthropic Messages content block. Kept intentionally
 * loose (every field beyond `type` is `unknown`) because routed providers
 * regularly emit extra keys or slightly off-shape blocks.
 */
export interface StructuredCallContentBlock {
	type: string;
	[key: string]: unknown;
}

/** Subset of the Messages API `usage` object; unknown extra keys pass through. */
export interface StructuredCallUsage {
	input_tokens?: number;
	output_tokens?: number;
	[key: string]: unknown;
}

/** Options for {@link executeStructuredCall}. Everything is caller-owned: no product-specific defaults leak in. */
export interface StructuredCallOptions {
	/** Base URL of an Anthropic Messages-compatible gateway. Trailing slashes are stripped; `/v1/messages` is appended. */
	baseUrl: string;
	/** Bearer token sent as `Authorization`. */
	authToken: string;
	/** Extra headers, merged last so they can override the defaults. */
	headers?: Record<string, string>;
	/** Fetch implementation override (tests, instrumented gateways). Defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Caller-owned abort signal, combined with the internal timeout signal. */
	signal?: AbortSignal;

	/** Model id requested from the gateway (routing aliases such as `openrouter/auto` are fine). */
	model: string;
	/** System prompt. */
	system: string;
	/** User-turn content (plain text). */
	user: string;
	/** Tool descriptors included in the request. */
	tools: StructuredCallTool[];
	/** Name of the tool the model must call — becomes `tool_choice.name`. */
	toolName: string;

	/** `max_tokens` for the call. Default 8000. */
	maxTokens?: number;
	/** Wall-clock budget for the fetch. Default 240_000 ms. */
	timeoutMs?: number;
	/**
	 * Send `thinking: {type: "disabled"}`. Default true — routed models that
	 * think by default can spend the whole output budget on `thinking` blocks
	 * and never emit the forced tool call.
	 */
	disableThinking?: boolean;
	/**
	 * OpenRouter-style `provider` extension (e.g. `{require_parameters: true}`).
	 * Only sent when provided: strict Anthropic endpoints reject unknown
	 * top-level body fields with a 400.
	 */
	provider?: Record<string, unknown>;
	/** Warning sink. Defaults to `console.warn` with a `[structured-call]` prefix. */
	onWarn?: (message: string) => void;
}

/** How the structured payload was recovered from the response. */
export type StructuredCallSource = "tool_use" | "text_json_fallback";

/** Successful outcome of a structured call. */
export interface StructuredCallSuccess {
	ok: true;
	/** Raw response content blocks (tool_use, text, thinking, ...). */
	content: StructuredCallContentBlock[];
	/** The decoded `toolInput` payload the caller asked for. */
	toolInput: unknown;
	/** `"tool_use"` when the forced call came back intact; `"text_json_fallback"` when it was recovered from embedded JSON in a text block. */
	source: StructuredCallSource;
	/** Model id the gateway reported as having served the call (OpenRouter routing may differ from the requested alias). Null when omitted. */
	responseModel: string | null;
	/** `stop_reason` reported by the gateway. Null when omitted. */
	stopReason: string | null;
	/** Token usage reported by the gateway. Undefined when omitted. */
	usage: StructuredCallUsage | undefined;
	/** HTTP status of the response. */
	status: number;
}

/** Why a structured call failed. */
export type StructuredCallErrorCode =
	| "network_error"
	| "timeout"
	| "aborted"
	| "http_error"
	| "decode_error"
	| "no_tool_use";

/** Failed outcome of a structured call. Never throws. */
export interface StructuredCallFailure {
	ok: false;
	code: StructuredCallErrorCode;
	message: string;
	/** HTTP status, when a response was received. */
	status?: number;
	/** Raw response body, when a response was received. */
	errorBody?: string;
	/** `type` of every content block — attached to `no_tool_use` for observability. */
	contentTypes?: string[];
}

/** Result of {@link executeStructuredCall}: success/failure discriminated union. */
export type StructuredCallResult = StructuredCallSuccess | StructuredCallFailure;
