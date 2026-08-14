/**
 * capture — second `agent/pre-step` listener that auto-captures user
 * messages into the OpenContext memory store. Registered AFTER recall
 * so the two listeners run in order: recall first, then capture.
 *
 * Gated by `config.capturePrompts` (default true). When false, the
 * listener no-ops. When true and `config.flushOnCapture` is false, the
 * capture is fire-and-forget — the turn is not blocked.
 */

import { classifyBackendError } from "./errors";
import { containsSecret } from "./secrets";
import type { OpenContextBackend } from "./backend";
import type { ResolvedConfig } from "./config";

interface DshPayload {
	messages?: Array<{ role?: string; content?: unknown }>;
	cwd?: string;
	session?: { header?: { id?: string; cwd?: string } };
}

function extractUserTexts(messages: DshPayload["messages"]): string[] {
	if (!Array.isArray(messages)) return [];
	const out: string[] = [];
	for (const m of messages) {
		if (!m || m.role !== "user") continue;
		const blocks = m.content;
		if (typeof blocks === "string") {
			if (blocks.trim()) out.push(blocks);
			continue;
		}
		if (!Array.isArray(blocks)) continue;
		const text = blocks
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text ?? "")
			.join("")
			.trim();
		if (text) out.push(text);
	}
	return out;
}

export function registerCapture(
	ctx: { on: (event: string, handler: (...args: never[]) => unknown) => () => void; logger: { warn: (msg: string) => void; debug?: (msg: string) => void } },
	backend: OpenContextBackend,
	config: ResolvedConfig,
): () => void {
	const handler = async (payload: unknown, next: () => Promise<unknown>): Promise<unknown> => {
		const downstream = await next();
		if (!config.capturePrompts) return downstream;
		const p = (payload ?? {}) as DshPayload;
		const messages = Array.isArray(p.messages) ? p.messages : [];
		if (messages.length === 0) return downstream;
		const cwd = p.session?.header?.cwd ?? p.cwd ?? process.cwd();
		const sessionId = p.session?.header?.id ?? "session-unknown";
		const scopeId = config.scopeId && config.scopeId.length > 0 ? config.scopeId : `local:${cwd}`;
		const texts = extractUserTexts(messages);
		if (texts.length === 0) return downstream;

		const runCaptures = async (): Promise<void> => {
			for (const text of texts) {
				if (!text || containsSecret(text)) continue;
				try {
					await backend.captureSource(
						{
							content: text,
							sourceType: "user_input",
							metadata: {
								sessionId,
								scopeId,
								ts: Date.now(),
							},
							scopeId,
							userId: scopeId,
						},
						{ timeoutMs: config.requestTimeoutMs },
					);
				} catch (error) {
					const cls = classifyBackendError(error);
					ctx.logger.warn(`[dsh-opencontext] capture failed: ${cls.code} ${cls.message}`);
				}
			}
		};

		if (config.flushOnCapture) {
			await runCaptures();
		} else {
			// Fire-and-forget. Swallow rejection so it never surfaces as an unhandledRejection.
			runCaptures().catch((error: unknown) => {
				const cls = classifyBackendError(error);
				ctx.logger.warn(`[dsh-opencontext] capture background failed: ${cls.code} ${cls.message}`);
			});
		}
		return downstream;
	};
	return ctx.on("agent/pre-step", handler as (...args: never[]) => unknown);
}
