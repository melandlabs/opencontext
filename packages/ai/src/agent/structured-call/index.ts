/**
 * Structured Call — single forced-tool LLM call primitive.
 *
 * Subpath entry for `@melandlabs/ai/agent/structured-call`. Not re-exported
 * from the agent barrel (see the NOTE in `../index.ts`); import from this
 * subpath or from the package root.
 */

export {
	DEFAULT_STRUCTURED_CALL_MAX_TOKENS,
	DEFAULT_STRUCTURED_CALL_TIMEOUT_MS,
	executeStructuredCall,
} from "./client";
export {
	DEFAULT_SHAPE_WRAPPER_KEYS,
	extractToolUseInput,
	findShapedObject,
} from "./decode";
export type {
	ExtractedToolUse,
	ExtractToolUseInputOptions,
	FindShapedObjectOptions,
} from "./decode";
export { extractBalancedJsonObject } from "./json";
export type {
	StructuredCallContentBlock,
	StructuredCallErrorCode,
	StructuredCallFailure,
	StructuredCallOptions,
	StructuredCallResult,
	StructuredCallSource,
	StructuredCallSuccess,
	StructuredCallTool,
	StructuredCallUsage,
} from "./types";
