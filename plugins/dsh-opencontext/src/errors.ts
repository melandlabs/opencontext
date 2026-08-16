/**
 * Error taxonomy for dsh-opencontext.
 *
 * Every tool and the recall/capture waterfall report failures as
 * `{ ok: false, code: ..., message: ... }` — never throw to the model.
 * These error codes are stable strings the host can switch on.
 */

export type ErrorCode =
	| "invalid_arguments"
	| "validation_failed"
	| "backend_unavailable"
	| "authentication_failed"
	| "server_unavailable"
	| "version_mismatch"
	| "invalid_response"
	| "not_found"
	| "timeout"
	| "secret_rejected"
	| "internal_error";

export interface ToolResult<T = unknown> {
	ok: boolean;
	code?: ErrorCode;
	message?: string;
	data?: T;
}

export function toolOk<T>(data: T): ToolResult<T> {
	return { ok: true, data };
}

export function toolError(code: ErrorCode, message: string): ToolResult {
	return { ok: false, code, message };
}

const MAX_CONTEXT_BYTES_DEFAULT = 8_000;
const MAX_SOURCE_LENGTH = 200_000;

export function classifyBackendError(error: unknown): {
	code: ErrorCode;
	message: string;
	statusCode?: number;
} {
	if (!error) return { code: "internal_error", message: "unknown error" };
	const err = error as {
		name?: string;
		message?: string;
		statusCode?: number;
		code?: string;
	};

	// AbortError from AbortSignal.timeout or fetch AbortController.
	if (err.name === "AbortError" || err.name === "TimeoutError") {
		return { code: "timeout", message: err.message ?? "request timed out" };
	}
	// Node fetch maps ECONNREFUSED / ENOTFOUND onto TypeError with .cause.
	if (err.name === "TypeError" || err instanceof TypeError) {
		return {
			code: "backend_unavailable",
			message: err.message ?? "backend unavailable",
		};
	}
	if (typeof err.statusCode === "number") {
		if (err.statusCode === 401 || err.statusCode === 403) {
			return {
				code: "authentication_failed",
				message: err.message ?? "authentication failed",
				statusCode: err.statusCode,
			};
		}
		if (err.statusCode === 404) {
			return {
				code: "version_mismatch",
				message: err.message ?? "endpoint not found",
				statusCode: err.statusCode,
			};
		}
		if (err.statusCode === 408) {
			return {
				code: "timeout",
				message: err.message ?? "request timed out",
				statusCode: err.statusCode,
			};
		}
		if (err.statusCode === 503) {
			return {
				code: "server_unavailable",
				message: err.message ?? "server unavailable",
				statusCode: err.statusCode,
			};
		}
		if (err.statusCode >= 500) {
			return {
				code: "server_unavailable",
				message: err.message ?? "server error",
				statusCode: err.statusCode,
			};
		}
		if (err.statusCode >= 400) {
			return {
				code: "invalid_response",
				message: err.message ?? "bad response",
				statusCode: err.statusCode,
			};
		}
	}
	return { code: "internal_error", message: err.message ?? String(error) };
}

export const constants = {
	MAX_CONTEXT_BYTES_DEFAULT,
	MAX_SOURCE_LENGTH,
	PLUGIN_NAME: "dsh-opencontext",
	REQUEST_ID_HEADER: "X-OpenContext-Request-ID",
};
