/**
 * events-turn-end — turn/end event listener for session summarization.
 *
 * This listener runs after each turn completes and can:
 * 1. Generate a summary of the turn
 * 2. Store task-outcome memories
 * 3. Consolidate related memories
 */

import type { OpenContextBackend } from "./backend.js";
import type { ResolvedConfig } from "./config.js";
import { classifyBackendError } from "./errors.js";
import { containsSecret } from "./secrets.js";

interface DshTurnPayload {
	messages?: Array<{ role?: string; content?: unknown }>;
	cwd?: string;
	session?: { header?: { id?: string; cwd?: string } };
	agentId?: string;
	toolsUsed?: string[];
}

interface TurnEndResult {
	summary?: string;
	outcomesCaptured: number;
	errors: string[];
}

function extractLastUserMessage(messages: DshTurnPayload["messages"]): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "user") {
			const content = m.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content
					.filter((b) => b?.type === "text" && typeof b?.text === "string")
					.map((b) => b.text)
					.join("\n");
			}
		}
	}
	return "";
}

function extractLastAssistantMessage(messages: DshTurnPayload["messages"]): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "assistant") {
			const content = m.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content
					.filter((b) => b?.type === "text" && typeof b?.text === "string")
					.map((b) => b.text)
					.join("\n");
			}
		}
	}
	return "";
}

/**
 * Generate a simple turn summary without LLM call.
 * For richer summaries, the host can provide an LLM service.
 */
function generateSimpleSummary(payload: DshTurnPayload): string {
	const userMsg = extractLastUserMessage(payload.messages);
	const assistantMsg = extractLastAssistantMessage(payload.messages);
	const tools = payload.toolsUsed ?? [];

	const parts: string[] = [];

	if (userMsg) {
		parts.push(`User: ${userMsg.slice(0, 200)}${userMsg.length > 200 ? "..." : ""}`);
	}

	if (tools.length > 0) {
		parts.push(`Tools used: ${tools.join(", ")}`);
	}

	if (assistantMsg) {
		parts.push("Response provided");
	}

	return parts.length > 0 ? parts.join("\n") : "Empty turn";
}

/**
 * Register the turn/end event listener
 */
export function registerTurnEndListener(
	ctx: {
		on: (event: string, handler: (...args: never[]) => unknown) => () => void;
		logger: {
			warn: (msg: string) => void;
			info?: (msg: string) => void;
			debug?: (msg: string) => void;
		};
	},
	backend: OpenContextBackend,
	config: ResolvedConfig,
): () => void {
	// Read config flags
	const autoSummarize = config.autoSummarize ?? false;
	const captureToolOutcomes = config.captureToolOutcomes ?? true;

	const handler = async (payload: unknown): Promise<TurnEndResult> => {
		const result: TurnEndResult = {
			outcomesCaptured: 0,
			errors: [],
		};

		try {
			const p = (payload ?? {}) as DshTurnPayload;
			const cwd = p.session?.header?.cwd ?? p.cwd ?? process.cwd();
			const sessionId = p.session?.header?.id ?? "session-unknown";
			const scopeId = config.scopeId && config.scopeId.length > 0 ? config.scopeId : `local:${cwd}`;

			// 1. Generate and store turn summary
			if (autoSummarize) {
				try {
					const summary = generateSimpleSummary(p);
					if (summary && !containsSecret(summary)) {
						await backend.remember(
							{
								content: summary,
								sourceType: "turn-summary",
								metadata: {
									sessionId,
									agentId: p.agentId,
									toolsUsed: p.toolsUsed ?? [],
									ts: Date.now(),
								},
								scopeId,
								userId: scopeId,
							},
							{ timeoutMs: config.requestTimeoutMs },
						);
						result.summary = summary;
						ctx.logger.info?.(`[dsh-opencontext] turn summary captured for session ${sessionId}`);
					}
				} catch (error) {
					const cls = classifyBackendError(error);
					result.errors.push(`summary: ${cls.code}`);
					ctx.logger.warn(`[dsh-opencontext] turn summary failed: ${cls.code} ${cls.message}`);
				}
			}

			// 2. Capture tool outcomes if enabled
			if (captureToolOutcomes && p.toolsUsed && p.toolsUsed.length > 0) {
				try {
					const assistantMsg = extractLastAssistantMessage(p.messages);
					if (assistantMsg && !containsSecret(assistantMsg)) {
						await backend.captureSource(
							{
								content: assistantMsg,
								sourceType: "tool-outcome",
								metadata: {
									sessionId,
									tools: p.toolsUsed,
									ts: Date.now(),
								},
								scopeId,
								userId: scopeId,
							},
							{ timeoutMs: config.requestTimeoutMs },
						);
						result.outcomesCaptured = 1;
					}
				} catch (error) {
					const cls = classifyBackendError(error);
					result.errors.push(`outcome: ${cls.code}`);
					ctx.logger.warn(`[dsh-opencontext] tool outcome capture failed: ${cls.code} ${cls.message}`);
				}
			}
		} catch (error) {
			const cls = classifyBackendError(error);
			result.errors.push(`unexpected: ${cls.code}`);
			ctx.logger.warn(`[dsh-opencontext] turn/end handler error: ${cls.code} ${cls.message}`);
		}

		return result;
	};

	return ctx.on("turn/end", handler as (...args: never[]) => unknown);
}
