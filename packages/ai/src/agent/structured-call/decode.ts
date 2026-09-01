/**
 * Structured Call — response decoding with wire tolerance.
 *
 * Generalized from alloomi's digital-employee planner: providers reached
 * through routing layers (OpenRouter, Bedrock fronts, ...) regularly deviate
 * from the Anthropic Messages contract even when `tool_choice` forces a
 * single tool call. These helpers recover the intended payload without
 * binding callers to any product schema.
 */

import { extractBalancedJsonObject } from "./json";

import type { StructuredCallSource } from "./types";

/**
 * Wrapper keys searched first (in order) when descending into a container,
 * before the generic value scan. These are the envelope names providers have
 * been observed to wrap payloads in.
 */
export const DEFAULT_SHAPE_WRAPPER_KEYS = [
	"plan",
	"response",
	"output",
	"result",
	"data",
	"payload",
] as const;

/** Default nesting budget for {@link findShapedObject}. */
const DEFAULT_MAX_DEPTH = 4;

/** Options for {@link findShapedObject}. */
export interface FindShapedObjectOptions {
	/** Wrapper keys searched before the generic value scan. Default {@link DEFAULT_SHAPE_WRAPPER_KEYS}. */
	wrapperKeys?: string[];
	/** Max object-nesting depth to descend. Default 4. Nodes at `maxDepth` can match but do not recurse further. */
	maxDepth?: number;
	/**
	 * Extra predicate applied to records that already contain every required
	 * key. Lets hosts port typed checks (e.g. `summary` must be a string,
	 * `actions` must be an array) without this module knowing the schema.
	 */
	matches?: (record: Record<string, unknown>) => boolean;
}

/**
 * Recursively locate the first object containing every `requiredKeys` entry
 * inside an opaque payload. Some providers wrap the payload in a container
 * key (`{plan: {...}}`) instead of emitting it at the top level; wrapper keys
 * are searched first so the canonical envelope wins over incidental matches
 * deeper in the generic value scan.
 *
 * Returns null when nothing matches so the caller's schema parser raises a
 * clear error rather than silently passing an empty object.
 */
export function findShapedObject(
	input: unknown,
	requiredKeys: readonly string[],
	options?: FindShapedObjectOptions,
): Record<string, unknown> | null {
	const wrapperKeys = options?.wrapperKeys ?? DEFAULT_SHAPE_WRAPPER_KEYS;
	const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
	return searchShapedObject(input, requiredKeys, wrapperKeys, maxDepth, options?.matches, 0);
}

function searchShapedObject(
	input: unknown,
	requiredKeys: readonly string[],
	wrapperKeys: readonly string[],
	maxDepth: number,
	matches: ((record: Record<string, unknown>) => boolean) | undefined,
	depth: number,
): Record<string, unknown> | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return null;
	}
	const record = input as Record<string, unknown>;
	if (requiredKeys.every((key) => key in record) && (!matches || matches(record))) {
		return record;
	}
	if (depth >= maxDepth) {
		return null;
	}
	for (const key of wrapperKeys) {
		const found = searchShapedObject(record[key], requiredKeys, wrapperKeys, maxDepth, matches, depth + 1);
		if (found) return found;
	}
	for (const value of Object.values(record)) {
		const found = searchShapedObject(value, requiredKeys, wrapperKeys, maxDepth, matches, depth + 1);
		if (found) return found;
	}
	return null;
}

/** Payload recovered from a response, plus how it was recovered. */
export interface ExtractedToolUse {
	/** The decoded tool input (or the JSON object recovered from a text block). */
	input: unknown;
	source: StructuredCallSource;
}

/** Options for {@link extractToolUseInput}. */
export interface ExtractToolUseInputOptions {
	/** Tool name the forced `tool_choice` requested. */
	toolName: string;
	/** Warning sink for recoverable deviations. */
	onWarn?: (message: string) => void;
}

/**
 * Pull the forced tool input out of a Messages response `content` array,
 * tolerating the deviations observed across providers:
 *   - 0 matching `tool_use` blocks → scan text blocks for an embedded JSON
 *     object (providers with degraded tool routing answer in prose).
 *   - ≥2 matching `tool_use` blocks → take the first and warn; parallel tool
 *     use should be disabled by `tool_choice` but some proxies ignore it.
 *   - `tool_use` blocks under a different name → ignored, same JSON fallback.
 *
 * Returns null when no recoverable payload is found so the caller can
 * surface a structured error.
 */
export function extractToolUseInput(
	content: readonly unknown[],
	options: ExtractToolUseInputOptions,
): ExtractedToolUse | null {
	const { toolName, onWarn } = options;
	const toolBlocks = content.filter(
		(block): block is Record<string, unknown> =>
			isRecord(block) && block.type === "tool_use" && block.name === toolName,
	);
	if (toolBlocks.length > 1) {
		onWarn?.(`multiple "${toolName}" tool_use blocks emitted (${toolBlocks.length}); taking the first`);
		return { input: toolBlocks[0].input, source: "tool_use" };
	}
	if (toolBlocks.length === 1) {
		return { input: toolBlocks[0].input, source: "tool_use" };
	}
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text") continue;
		const text = block.text;
		if (typeof text !== "string" || text.length === 0) continue;
		const json = extractBalancedJsonObject(text);
		if (json === null) continue;
		try {
			return { input: JSON.parse(json), source: "text_json_fallback" };
		} catch {
			// Try the next text block; some providers emit reasoning alongside
			// (or before) the JSON payload.
		}
	}
	onWarn?.(
		`no "${toolName}" tool_use block or embedded JSON object found (contentTypes: ${content
			.map((block) => (isRecord(block) && typeof block.type === "string" ? block.type : "unknown"))
			.join(", ")})`,
	);
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
