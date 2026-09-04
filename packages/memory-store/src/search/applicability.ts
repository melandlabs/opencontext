import type { MemoryApplicabilityContext, MemoryApplicabilityScope } from "@melandlabs/memory-consolidation";

import type { SearchInput } from "./utilities";

const APPLICABILITY_SCOPES: ReadonlySet<MemoryApplicabilityScope> = new Set([
	"global",
	"task",
	"conversation",
	"channel",
	"project",
	"custom",
]);

/**
 * Trusted, in-process context for one `search()` call. Hosts must derive these
 * contexts from authenticated server-side state rather than public payloads.
 * An explicit empty array requests global-only retrieval; omitting the runtime
 * context preserves legacy unscoped behaviour.
 */
export interface SearchRuntimeContext {
	applicabilityContexts: readonly MemoryApplicabilityContext[];
}

/** Validated context shared by every retrieval performed for one search. */
export interface ResolvedSearchRuntimeContext {
	applicabilityContexts: readonly MemoryApplicabilityContext[];
	/** Epoch milliseconds, resolved exactly once at the search boundary. */
	applicabilityAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRuntimeContext(message: string): never {
	throw new TypeError(`memory-store search runtime context: ${message}`);
}

function validateApplicabilityContext(value: unknown, index: number): void {
	const path = `applicabilityContexts[${index}]`;
	if (!isRecord(value)) {
		invalidRuntimeContext(`${path} must be an object`);
	}

	const scope = value.scope;
	if (typeof scope !== "string" || !APPLICABILITY_SCOPES.has(scope as MemoryApplicabilityScope)) {
		invalidRuntimeContext(`${path}.scope is not supported`);
	}

	if (value.key !== undefined && typeof value.key !== "string") {
		invalidRuntimeContext(`${path}.key must be a string when provided`);
	}
	if (scope !== "global" && (typeof value.key !== "string" || value.key.trim().length === 0)) {
		invalidRuntimeContext(`${path}.key must be non-empty for scope "${scope}"`);
	}

	for (const field of ["validFrom", "validUntil"] as const) {
		const boundary = value[field];
		if (boundary !== undefined && (typeof boundary !== "number" || !Number.isFinite(boundary))) {
			invalidRuntimeContext(`${path}.${field} must be a finite epoch-millisecond number`);
		}
	}
}

/**
 * Validate and resolve the trusted runtime context before any retrieval or LLM
 * callback is invoked. The applicability array is deliberately returned by
 * reference so downstream providers can receive the host-supplied value
 * unchanged.
 */
export function resolveSearchRuntimeContext(
	input: Pick<SearchInput, "asOf">,
	runtimeContext: SearchRuntimeContext | undefined,
	now: () => number = Date.now,
): ResolvedSearchRuntimeContext | undefined {
	if (runtimeContext === undefined) {
		return undefined;
	}
	if (!isRecord(runtimeContext) || !Array.isArray(runtimeContext.applicabilityContexts)) {
		invalidRuntimeContext("applicabilityContexts must be an array");
	}

	for (const [index, context] of runtimeContext.applicabilityContexts.entries()) {
		validateApplicabilityContext(context, index);
	}

	let applicabilityAt: number;
	if (input.asOf === undefined) {
		applicabilityAt = now();
	} else {
		const parsed = typeof input.asOf === "string" ? Date.parse(input.asOf) : Number.NaN;
		if (!Number.isFinite(parsed)) {
			invalidRuntimeContext("asOf must be a parseable timestamp when a runtime context is supplied");
		}
		applicabilityAt = parsed;
	}

	return {
		applicabilityContexts: runtimeContext.applicabilityContexts,
		applicabilityAt,
	};
}
