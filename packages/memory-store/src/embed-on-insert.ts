/**
 * Embed-on-insert policy and the helper it sits on top of.
 *
 * Three policy paths (the MCP `memory.writeRawMessage` handler and the HTTP
 * `POST /v1/raw-messages` handler MUST agree on all three):
 *
 *   (a) `embedOnInsert === true` AND any row is missing an embedding
 *       → fill in the gaps via `unified.embedQuery`.
 *   (b) `embedOnInsert` is falsy AND the host has `unified.embedQuery` wired
 *       AND a row is missing an embedding
 *       → fill in the gaps AND surface a `embed_on_insert_auto_applied`
 *       warning. Without this, vector backends (sqlite-vec, chroma, …)
 *       silently return 0 hits because the row has no vector — the worst
 *       kind of silent failure.
 *   (c) Otherwise: respect the caller's pre-embedded rows verbatim.
 *       Sidecar-embedded data shouldn't pay for a server-side inference
 *       round-trip per row.
 *
 * `embedMissingMessages` is the lower-level worker that *only* fills gaps;
 * it does not look at `embedOnInsert`. The policy wrapper above decides
 * whether to call it.
 */
import type { RawMessage } from "@melandlabs/indexeddb";

import type { UnifiedSearchDeps } from "./config";

/**
 * Fill in missing embeddings on a list of raw messages.
 *
 * Pre-embedded rows are returned untouched. Rows with non-string `content`
 * or empty `content` are also returned untouched (can't embed them).
 * Rows with no embedding but with a string `content` go through
 * `deps.embedQuery` exactly once each.
 */
export async function embedMissingMessages(
	messages: RawMessage[],
	deps: UnifiedSearchDeps,
): Promise<RawMessage[]> {
	if (typeof deps.embedQuery !== "function") {
		return messages;
	}
	const out: RawMessage[] = [];
	for (const message of messages) {
		if (Array.isArray(message.embedding) && message.embedding.length > 0) {
			out.push(message);
			continue;
		}
		if (typeof message.content !== "string" || message.content.length === 0) {
			out.push(message);
			continue;
		}
		const vector = await deps.embedQuery({
			userId: message.userId,
			query: message.content,
		});
		out.push({
			...message,
			embedding: vector,
			embeddingModel: message.embeddingModel ?? "server",
			embeddingDimensions: vector.length,
			embeddingUpdatedAt: Date.now(),
		});
	}
	return out;
}

export interface EmbedOnInsertWarning {
	code: string;
	message: string;
}

export interface EmbedOnInsertResult {
	/** The messages after the policy decided what (if anything) to embed. */
	messages: RawMessage[];
	/** Non-empty only when path (b) fired. */
	warnings: EmbedOnInsertWarning[];
}

const AUTO_APPLIED_WARNING: EmbedOnInsertWarning = {
	code: "embed_on_insert_auto_applied",
	message:
		"Caller set `embedOnInsert` falsy but the active vector backend " +
		"needs an embedding per row. Server filled in the missing " +
		"embeddings; pass `embedOnInsert: true` to opt in explicitly.",
};

/**
 * Apply the embed-on-insert policy described at the top of this file.
 *
 * Pure with respect to `embedMissingMessages`: callers can pass a `unified`
 * without `embedQuery` (no auto-embed available), with `embedQuery`
 * (auto-embed possible), or an empty object. The policy is intentionally
 * idempotent: invoking it twice on the same input is a no-op the second
 * time because every row will already have an embedding.
 */
export async function applyEmbedOnInsertPolicy(
	incoming: RawMessage[],
	embedOnInsert: boolean | undefined,
	unified: UnifiedSearchDeps | undefined,
): Promise<EmbedOnInsertResult> {
	const messages = incoming;
	const anyMissing = incoming.some(
		(m) => !Array.isArray(m.embedding) || m.embedding.length === 0,
	);
	const embedderWired = typeof (unified ?? {}).embedQuery === "function";

	if (embedOnInsert === true && anyMissing) {
		return { messages: await embedMissingMessages(messages, unified ?? {}), warnings: [] };
	}
	if (embedOnInsert !== true && anyMissing && embedderWired) {
		return {
			messages: await embedMissingMessages(messages, unified ?? {}),
			warnings: [AUTO_APPLIED_WARNING],
		};
	}
	return { messages, warnings: [] };
}
