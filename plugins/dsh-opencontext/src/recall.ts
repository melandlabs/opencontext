/**
 * recall — agent/pre-step waterfall that prepends a <opencontext_evidence>
 * block to the system prompt on every turn.
 *
 * Strategy:
 *   1. Derive a query from the last user message in the payload.
 *   2. Call `backend.search` with the configured cap and timeout.
 *   3. Format hits via `formatPreparedContext` (byte-budgeted).
 *   4. If a non-empty block is produced, append it as a new user
 *      message wrapped in untrusted-evidence framing.
 *   5. If anything fails, log a warning and pass through `next()`.
 */

import type { OpenContextBackend, SearchHit } from "./backend.js";
import type { ResolvedConfig } from "./config.js";
import { classifyBackendError } from "./errors.js";
import { deriveQuery, formatPreparedContext } from "./prepared-context.js";

interface DshPayload {
	messages?: unknown[];
	cwd?: string;
	session?: { header?: { id?: string; cwd?: string } };
}

interface PreStepDecision {
	kind: string;
	messages?: unknown[];
}

type Next = () => Promise<PreStepDecision>;

export function registerRecall(
	ctx: {
		on: (event: string, handler: (...args: never[]) => unknown) => () => void;
		logger: { warn: (msg: string) => void; debug?: (msg: string) => void };
	},
	backend: OpenContextBackend,
	config: ResolvedConfig,
): () => void {
	const handler = async (payload: unknown, next: Next): Promise<PreStepDecision> => {
		try {
			const p = (payload ?? {}) as DshPayload;
			const messages = Array.isArray(p.messages) ? p.messages : [];
			if (messages.length === 0) return await next();
			const query = deriveQuery(messages as Array<{ content?: unknown }>);
			if (!query) return await next();
			const cwd = p.session?.header?.cwd ?? p.cwd ?? process.cwd();
			const sessionId = p.session?.header?.id ?? "session-unknown";
			const scopeId = config.scopeId && config.scopeId.length > 0 ? config.scopeId : `local:${cwd}`;

			let hits: SearchHit[] | undefined;
			try {
				hits = await backend.search(
					{
						query,
						limit: config.maxRecallItems,
						scopeId,
						userId: scopeId,
					},
					{ timeoutMs: config.requestTimeoutMs },
				);
			} catch (error) {
				const cls = classifyBackendError(error);
				ctx.logger.warn(`[dsh-opencontext] recall failed: ${cls.code} ${cls.message}`);
				return await next();
			}

			const prepared = formatPreparedContext(hits, config.maxBytes);
			const decision = await next();
			if (!prepared.content || prepared.status === "empty" || decision.kind !== "enter") {
				return decision;
			}
			const wrappedMessage = {
				role: "user",
				content: [
					{
						type: "text",
						text: prepared.content,
					},
				],
				source: { kind: "plugin", plugin: "dsh-opencontext" },
				meta: { kind: "recall", sessionId, scopeId, hits: hits.length },
			};
			return {
				kind: "enter",
				messages: [...(decision.messages ?? []), wrappedMessage],
			};
		} catch (error) {
			const cls = classifyBackendError(error);
			ctx.logger.warn(`[dsh-opencontext] recall waterfall error: ${cls.code} ${cls.message}`);
			return await next();
		}
	};
	return ctx.on("agent/pre-step", handler as (...args: never[]) => unknown);
}
