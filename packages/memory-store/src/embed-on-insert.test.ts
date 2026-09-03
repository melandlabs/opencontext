/**
 * Unit tests for the embed-on-insert policy shared by the HTTP
 * `POST /v1/raw-messages` handler and the MCP `memory.writeRawMessage` tool.
 *
 * The bug we don't want again: a caller passes `embedOnInsert: false`
 * (or omits the flag) AND the message has no embedding AND the active
 * backend is vector-based (sqlite-vec, chroma, …). Without the auto-apply
 * path, the write succeeds, but search silently returns 0 hits because the
 * row has no vector. The "worst kind of silent failure". These tests pin
 * all three policy paths.
 */
import { describe, expect, it, vi } from "vitest";

import type { RawMessage } from "@melandlabs/indexeddb";

import type { UnifiedSearchDeps } from "./config";
import { applyEmbedOnInsertPolicy, embedMissingMessages, prepareRawMessageIngest } from "./embed-on-insert";

const baseMessage = (overrides: Partial<RawMessage> = {}): RawMessage => ({
	messageId: "m-1",
	userId: "u-1",
	content: "hello",
	platform: "test",
	botId: "test-bot",
	timestamp: 0,
	createdAt: 0,
	...overrides,
});

describe("applyEmbedOnInsertPolicy", () => {
	it("path (a) — `embedOnInsert: true` fills missing embeddings without warnings", async () => {
		const embedQuery = vi.fn(async () => [0.1, 0.2, 0.3]);
		const unified: UnifiedSearchDeps = { embedQuery };
		const incoming = [baseMessage(), baseMessage({ messageId: "m-2" })];

		const out = await applyEmbedOnInsertPolicy(incoming, true, unified);

		expect(embedQuery).toHaveBeenCalledTimes(2);
		expect(out.warnings).toHaveLength(0);
		for (const m of out.messages) {
			expect(m.embedding).toEqual([0.1, 0.2, 0.3]);
			expect(m.embeddingModel).toBe("server");
		}
	});

	it("path (b) — caller falsy, embedder wired, row missing → auto-embed + warning", async () => {
		const embedQuery = vi.fn(async () => [0.4, 0.5]);
		const unified: UnifiedSearchDeps = { embedQuery };
		const incoming = [baseMessage()];

		const out = await applyEmbedOnInsertPolicy(incoming, false, unified);

		expect(embedQuery).toHaveBeenCalledTimes(1);
		expect(out.messages[0].embedding).toEqual([0.4, 0.5]);
		expect(out.warnings).toEqual([expect.objectContaining({ code: "embed_on_insert_auto_applied" })]);
	});

	it("path (b) — `embedOnInsert` undefined triggers auto-embed with warning", async () => {
		const embedQuery = vi.fn(async () => [0.7]);
		const unified: UnifiedSearchDeps = { embedQuery };
		const incoming = [baseMessage()];

		const out = await applyEmbedOnInsertPolicy(incoming, undefined, unified);

		expect(embedQuery).toHaveBeenCalledTimes(1);
		expect(out.warnings[0]?.code).toBe("embed_on_insert_auto_applied");
	});

	it("path (c) — caller falsy, embedder NOT wired → lexical-only warning", async () => {
		const incoming = [baseMessage()];
		const out = await applyEmbedOnInsertPolicy(incoming, false, {});

		expect(out.messages).toEqual(incoming);
		expect(out.warnings).toEqual([expect.objectContaining({ code: "semantic_index_unavailable" })]);
	});

	it("path (c) — caller falsy, rows already have embeddings → rows verbatim, no warnings", async () => {
		const embedQuery = vi.fn();
		const unified: UnifiedSearchDeps = { embedQuery };
		const preEmbedded = baseMessage({ embedding: [1, 0, 0], embeddingModel: "sidecar" });

		const out = await applyEmbedOnInsertPolicy([preEmbedded], false, unified);

		expect(embedQuery).not.toHaveBeenCalled();
		expect(out.messages[0]).toBe(preEmbedded); // verbatim — same reference
		expect(out.warnings).toHaveLength(0);
	});

	it("path (c) — caller true, but every row already embedded → no embed call, no warning", async () => {
		const embedQuery = vi.fn();
		const unified: UnifiedSearchDeps = { embedQuery };
		const preEmbedded = baseMessage({ embedding: [1, 0, 0] });

		const out = await applyEmbedOnInsertPolicy([preEmbedded], true, unified);

		expect(embedQuery).not.toHaveBeenCalled();
		expect(out.warnings).toHaveLength(0);
	});

	it("is idempotent — invoking twice on the same input is a no-op the second time", async () => {
		const embedQuery = vi.fn(async () => [0.1, 0.2]);
		const unified: UnifiedSearchDeps = { embedQuery };
		const incoming = [baseMessage()];

		const first = await applyEmbedOnInsertPolicy(incoming, false, unified);
		const second = await applyEmbedOnInsertPolicy(first.messages, false, unified);

		expect(embedQuery).toHaveBeenCalledTimes(1); // only the first call
		expect(second.warnings).toHaveLength(0);
	});

	it("undefined `unified` is treated like a backend without an embedder", async () => {
		const incoming = [baseMessage()];
		const out = await applyEmbedOnInsertPolicy(incoming, true, undefined);

		expect(out.messages).toEqual(incoming);
		expect(out.warnings).toEqual([expect.objectContaining({ code: "semantic_index_unavailable" })]);
	});
});

describe("embedMissingMessages", () => {
	it("returns messages untouched when no embedder is wired", async () => {
		const incoming = [baseMessage()];
		const out = await embedMissingMessages(incoming, {});
		expect(out).toBe(incoming);
	});

	it("preserves pre-embedded rows verbatim", async () => {
		const embedQuery = vi.fn();
		const preEmbedded = baseMessage({ embedding: [1, 0, 0], embeddingModel: "sidecar" });
		const out = await embedMissingMessages([preEmbedded], { embedQuery });
		expect(embedQuery).not.toHaveBeenCalled();
		expect(out[0]).toBe(preEmbedded);
	});

	it("skips rows with empty content (can't embed them)", async () => {
		const embedQuery = vi.fn();
		const empty = baseMessage({ content: "", embedding: undefined });
		const out = await embedMissingMessages([empty], { embedQuery });
		expect(embedQuery).not.toHaveBeenCalled();
		expect(out[0]).toBe(empty);
	});

	it("embeds every long-message child independently without changing the parent content", async () => {
		const embedQuery = vi.fn(async () => [0.1, 0.2]);
		const message = baseMessage({
			content: Array.from({ length: 300 }, (_, index) => `sentence-${index}`).join(" "),
		});
		const out = await prepareRawMessageIngest([message], true, { embedQuery });

		expect(out.chunks.length).toBeGreaterThan(1);
		expect(embedQuery).toHaveBeenCalledTimes(out.chunks.length);
		expect(out.messages[0]?.content).toBe(message.content);
		expect(out.messages[0]?.embedding).toBeUndefined();
		expect(out.chunks.every((chunk) => chunk.embedding?.length === 2)).toBe(true);
	});

	it("batches child embeddings across an ingest request when the provider supports it", async () => {
		const embedQuery = vi.fn(async () => [9, 9]);
		const embedDocuments = vi.fn(async ({ texts }: { texts: string[] }) =>
			texts.map((_, index) => [index + 1, index + 2]),
		);
		const messages = [
			baseMessage({
				content: Array.from({ length: 300 }, (_, index) => `alpha-${index}`).join(" "),
			}),
			baseMessage({ messageId: "m-2", content: "short message" }),
		];

		const out = await prepareRawMessageIngest(messages, true, {
			embedQuery,
			embedDocuments,
		});

		expect(embedDocuments).toHaveBeenCalledTimes(1);
		expect(embedDocuments.mock.calls[0]?.[0].texts).toHaveLength(out.chunks.length);
		expect(embedQuery).not.toHaveBeenCalled();
		expect(out.chunks.every((chunk) => chunk.embedding?.length === 2)).toBe(true);
	});

	it("does not index an all-zero provider vector as a semantic child", async () => {
		const out = await prepareRawMessageIngest([baseMessage()], true, {
			embedQuery: async () => [0, 0, 0],
		});

		expect(out.chunks[0]?.embedding).toBeUndefined();
		expect(out.warnings).toEqual([expect.objectContaining({ code: "semantic_index_unavailable" })]);
	});
});
