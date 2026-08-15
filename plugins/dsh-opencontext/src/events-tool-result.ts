/**
 * events-tool-result — tool/result event listener for capturing tool outputs.
 *
 * This listener captures tool call results and stores them as memories,
 * creating a searchable log of all tool interactions.
 */

import { containsSecret } from "./secrets.js";
import { classifyBackendError } from "./errors.js";
import type { OpenContextBackend } from "./backend.js";
import type { ResolvedConfig } from "./config.js";

interface DshToolResultPayload {
	tool?: string;
	arguments?: Record<string, unknown>;
	result?: unknown;
	error?: { message?: string; code?: string };
	cwd?: string;
	session?: { header?: { id?: string; cwd?: string } };
}

interface ToolResultCapture {
	tool: string;
	success: boolean;
	captured: boolean;
	error?: string;
}

/**
 * Sanitize tool arguments for storage (remove secrets)
 */
function sanitizeArguments(
	args: Record<string, unknown>
): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	const secretKeys = [
		"password",
		"token",
		"secret",
		"apiKey",
		"api_key",
		"auth",
		"credential",
	];

	for (const [key, value] of Object.entries(args)) {
		const lowerKey = key.toLowerCase();
		if (secretKeys.some((sk) => lowerKey.includes(sk))) {
			sanitized[key] = "[REDACTED]";
		} else if (typeof value === "string" && containsSecret(value)) {
			sanitized[key] = "[REDACTED]";
		} else if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value)
		) {
			sanitized[key] = sanitizeArguments(value as Record<string, unknown>);
		} else {
			sanitized[key] = value;
		}
	}

	return sanitized;
}

/**
 * Format tool result for storage
 */
function formatToolResult(result: unknown): string {
	if (result === undefined) return "";
	if (result === null) return "null";

	if (typeof result === "string") {
		return containsSecret(result) ? "[REDACTED - potential secret]" : result;
	}

	if (typeof result === "boolean" || typeof result === "number") {
		return String(result);
	}

	if (Array.isArray(result)) {
		return "[array data]";
	}

	if (typeof result === "object") {
		// Check for secret content
		const json = JSON.stringify(result);
		if (containsSecret(json)) {
			return "[REDACTED - potential secret]";
		}

		// Truncate large objects
		if (json.length > 1000) {
			return json.slice(0, 1000) + "...";
		}
		return json;
	}

	return String(result);
}

/**
 * Register the tool/result event listener
 */
export function registerToolResultListener(
	ctx: {
		on: (event: string, handler: (...args: never[]) => unknown) => () => void;
		logger: { warn: (msg: string) => void; debug?: (msg: string) => void };
	},
	backend: OpenContextBackend,
	config: ResolvedConfig
): () => void {
	// Read config flag
	const captureToolResults =
		(config as ResolvedConfig & { captureToolResults?: boolean })
			.captureToolResults ?? false;

	if (!captureToolResults) {
		// Return a no-op disposer
		return () => {};
	}

	const handler = async (
		payload: unknown,
		next: () => Promise<unknown>
	): Promise<unknown> => {
		// Call next first to let the tool execute
		const downstream = await next();

		try {
			const p = (payload ?? {}) as DshToolResultPayload;
			const toolName = p.tool;

			if (!toolName) return downstream;

			// Early exit if result contains a secret (check raw result before formatting)
			if (p.result !== undefined) {
				const resultStr = JSON.stringify(p.result);
				if (containsSecret(resultStr)) {
					ctx.logger.debug?.(
						`[dsh-opencontext] skipping tool result with potential secret in output`
					);
					return downstream;
				}
			}

			const cwd = p.session?.header?.cwd ?? p.cwd ?? process.cwd();
			const sessionId = p.session?.header?.id ?? "session-unknown";
			const scopeId =
				config.scopeId && config.scopeId.length > 0
					? config.scopeId
					: `local:${cwd}`;

			// Build the memory content
			const parts: string[] = [];
			parts.push(`Tool: ${toolName}`);

			if (p.arguments) {
				const sanitized = sanitizeArguments(p.arguments);
				parts.push(`Arguments: ${JSON.stringify(sanitized)}`);
			}

			const success = !p.error;
			parts.push(`Status: ${success ? "SUCCESS" : "ERROR"}`);

			if (p.error) {
				parts.push(`Error: ${p.error.message || p.error.code || "Unknown"}`);
			}

			// Add result summary (if available and safe)
			if (success && p.result !== undefined) {
				const resultStr = formatToolResult(p.result);
				if (resultStr && !resultStr.includes("[REDACTED]")) {
					parts.push(`Result: ${resultStr}`);
				}
			}

			const content = parts.join("\n");

			// Check for secrets in final content
			if (containsSecret(content)) {
				ctx.logger.debug?.(
					`[dsh-opencontext] skipping tool result with potential secret`
				);
				return downstream;
			}

			// Store as tool-interaction memory
			await backend.captureSource(
				{
					content,
					sourceType: "tool-interaction",
					metadata: {
						tool: toolName,
						sessionId,
						success,
						ts: Date.now(),
					},
					scopeId,
					userId: scopeId,
				},
				{ timeoutMs: config.requestTimeoutMs }
			);

			ctx.logger.debug?.(
				`[dsh-opencontext] captured tool result for ${toolName}`
			);
		} catch (error) {
			const cls = classifyBackendError(error);
			ctx.logger.warn(
				`[dsh-opencontext] tool result capture failed: ${cls.code} ${cls.message}`
			);
		}

		return downstream;
	};

	return ctx.on("tool/result", handler as (...args: never[]) => unknown);
}
