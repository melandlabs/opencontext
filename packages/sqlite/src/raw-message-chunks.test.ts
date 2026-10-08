import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawMessage } from "../../indexeddb/src/storage";
import { estimateTokens } from "../../shared/src/tokens";
import { SQLiteRawMessageManager } from "./raw-message-manager";

let scratchDir: string;

beforeEach(() => {
	scratchDir = mkdtempSync(join(tmpdir(), "sqlite-raw-chunks-"));
});

afterEach(() => {
	rmSync(scratchDir, { recursive: true, force: true });
});

function longMessage(): RawMessage {
	const paragraphs = Array.from(
		{ length: 22 },
		(_, index) => `Section ${index}. ${"context detail ".repeat(38)} marker-${index}.`,
	);
	return {
		messageId: "long-parent",
		platform: "test",
		botId: "bot",
		userId: "user",
		timestamp: 1,
		createdAt: 1,
		content: paragraphs.join("\n\n"),
	};
}

describe("SQLite RawMessage child index", () => {
	it("reindexes children without changing any original parent field and rejects stale or incomplete plans", async () => {
		const db = new Database(join(scratchDir, "reindex.db"));
		const manager = new SQLiteRawMessageManager({ db });
		const message = longMessage();
		await manager.storeMessage(message);
		const before = db.prepare("SELECT * FROM raw_messages").all();
		const chunks = await manager.getRawMessageSearchChunks({ messageIds: [message.messageId] });
		const plan = {
			messageId: message.messageId,
			userId: message.userId,
			contentHash: createHash("sha256").update(message.content).digest("hex"),
			chunks: chunks.map((chunk) => ({
				...chunk,
				embedding: [1, 0, 0],
				embeddingModel: "new-model",
				embeddingDimensions: 3,
			})),
		};
		await manager.replaceMessageSearchChunks([plan]);
		expect(db.prepare("SELECT * FROM raw_messages").all()).toEqual(before);
		const valid = await manager.getRawMessageSearchChunks({ messageIds: [message.messageId] });
		await expect(
			manager.replaceMessageSearchChunks([plan, { ...plan, contentHash: "stale" }]),
		).rejects.toThrow("content_conflict");
		await expect(manager.replaceMessageSearchChunks([{ ...plan, userId: "another-user" }])).rejects.toThrow(
			"scope_conflict",
		);
		await expect(
			manager.replaceMessageSearchChunks([{ ...plan, chunks: plan.chunks.slice(1) }]),
		).rejects.toThrow("coverage");
		await expect(
			manager.replaceMessageSearchChunks([{ ...plan, chunks: plan.chunks.slice(0, -1) }]),
		).rejects.toThrow("incomplete");
		expect(await manager.getRawMessageSearchChunks({ messageIds: [message.messageId] })).toEqual(valid);
		expect(await manager.lexicalSearchMessages({ userId: "user", keywords: ["marker-10"] })).not.toHaveLength(
			0,
		);
		expect(
			(
				await manager.searchMessagesSemantically({
					userId: "user",
					queryEmbedding: [1, 0, 0],
					embeddingModel: "new-model",
					limit: 1,
				})
			)[0]?.id,
		).toBe(message.messageId);
		await manager.close();
		db.close();
	});
	it("keeps one complete parent and tracks exact child offsets", async () => {
		const manager = new SQLiteRawMessageManager({ dbPath: join(scratchDir, "store.db") });
		const message = longMessage();
		await manager.storeMessage(message);

		const stored = await manager.getMessageById(message.messageId);
		const chunks = await manager.getRawMessageSearchChunks({ messageIds: [message.messageId] });
		expect(stored?.content).toBe(message.content);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.chunkCount).toBe(chunks.length);
			expect(chunk.content).toBe(message.content.slice(chunk.startPosition, chunk.endPosition));
			expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(400);
		}

		const lexical = await manager.lexicalSearchMessages({ userId: "user", keywords: ["marker-10"] });
		expect(lexical[0]?.id).toBe(message.messageId);
		expect(lexical[0]?.content).toContain("marker-10");
		expect(estimateTokens(lexical[0]?.content ?? "")).toBeLessThanOrEqual(1_040);
		const spans = lexical[0]?.metadata.matchedSpans as Array<{
			matchedContent: string;
			matchedStartPosition: number;
			matchedEndPosition: number;
		}>;
		for (const span of spans) {
			expect(span.matchedContent).toBe(
				message.content.slice(span.matchedStartPosition, span.matchedEndPosition),
			);
			expect(
				chunks.some(
					(chunk) =>
						chunk.content === span.matchedContent && chunk.startPosition === span.matchedStartPosition,
				),
			).toBe(true);
		}
		await manager.close();
	});

	it("embeds children independently and returns one parent result", async () => {
		const manager = new SQLiteRawMessageManager({ dbPath: join(scratchDir, "store.db") });
		const message = longMessage();
		await manager.storeMessage(message);
		const chunks = await manager.getRawMessageSearchChunks({ messageIds: [message.messageId] });
		await manager.storeMessagesWithSearchChunks(
			[message],
			chunks.map((chunk, index) => ({
				...chunk,
				embedding: index === 1 ? [1, 0, 0] : index === chunks.length - 2 ? [0.98, 0.02, 0] : [0, 1, 0],
				embeddingModel: "fixture",
				embeddingDimensions: 3,
				embeddingUpdatedAt: 1,
			})),
		);

		const hits = await manager.searchMessagesSemantically({
			userId: "user",
			queryEmbedding: [1, 0, 0],
			embeddingModel: "fixture",
			threshold: 0.8,
			limit: 8,
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.id).toBe(message.messageId);
		expect(hits[0]?.metadata.sourceChunkId).toBe(chunks[1]?.chunkId);
		expect(hits[0]?.content.length).toBeLessThan(message.content.length);
		expect((hits[0]?.metadata.matchedSpans as unknown[]).length).toBeGreaterThanOrEqual(2);

		const stats = await manager.getRawMessageSearchIndexStats();
		expect(stats).toMatchObject({
			messageCount: 1,
			chunkCount: chunks.length,
			embeddedChunkCount: chunks.length,
			lexicalReady: true,
			semanticReady: true,
		});
		await manager.close();
	});

	it("retains separate lexical windows from one long parent", async () => {
		const manager = new SQLiteRawMessageManager({ dbPath: join(scratchDir, "multi-span.db") });
		const message = longMessage();
		message.content = message.content
			.replace("marker-2.", "marker-2. rareevidence.")
			.replace("marker-18.", "marker-18. rareevidence.");
		await manager.storeMessage(message);
		const hits = await manager.lexicalSearchMessages({
			userId: "user",
			keywords: ["rareevidence"],
			limit: 4,
		});
		await manager.close();
		expect(hits).toHaveLength(1);
		const spans = hits[0]?.metadata.matchedSpans as Array<{
			content: string;
			startPosition: number;
			endPosition: number;
		}>;
		expect(spans.length).toBeGreaterThanOrEqual(2);
		expect(spans[0]?.content).toContain("marker-2");
		expect(spans.some((span) => span.content.includes("marker-18"))).toBe(true);
		for (const span of spans) {
			expect(span.content).toBe(message.content.slice(span.startPosition, span.endPosition));
		}
	});

	it.each(["visible", "crowded-out"])(
		"keeps underfilled user-scoped vector results when widening expires (%s)",
		async (position) => {
			const manager = new SQLiteRawMessageManager({ dbPath: join(scratchDir, "underfilled.db") });
			const base = { platform: "test", botId: "bot", timestamp: 1, createdAt: 1 };
			const messages: RawMessage[] = [
				{ ...base, messageId: "owned", userId: "user", content: "The answer is here." },
				...Array.from({ length: 64 }, (_, index) => ({
					...base,
					messageId: `other-${index}`,
					userId: "other-user",
					content: `Distractor ${index}.`,
				})),
			];
			await manager.storeMessages(messages);
			const chunks = await manager.getRawMessageSearchChunks({
				messageIds: messages.map((message) => message.messageId),
			});
			await manager.storeMessagesWithSearchChunks(
				messages,
				chunks.map((chunk) => ({
					...chunk,
					embedding: (chunk.messageId === "owned") === (position === "visible") ? [1, 0, 0] : [0.9, 0.1, 0],
					embeddingModel: "fixture",
					embeddingDimensions: 3,
					embeddingUpdatedAt: 1,
				})),
			);
			expect((await manager.getRawMessageSearchIndexStats()).semanticReady).toBe(true);
			const hits = await manager.searchMessagesSemantically({
				userId: "user",
				queryEmbedding: [1, 0, 0],
				threshold: 0.5,
				limit: 2,
				scanLimit: 8,
			});
			await manager.close();
			expect(hits.map((hit) => hit.id)).toEqual(["owned"]);
			expect(hits[0]?.metadata.vectorScanUnderfilled).toBe(true);
			expect(hits[0]?.metadata.vectorScanLimit).toBe(64);
			expect(hits[0]?.metadata.vectorSearchFallback).toBe("user-scoped-exact");
		},
	);

	it("removes child catalog and vectors when the parent is cleared", async () => {
		const manager = new SQLiteRawMessageManager({ dbPath: join(scratchDir, "store.db") });
		await manager.storeMessage(longMessage());
		await manager.clearAll();
		expect(await manager.getRawMessageSearchIndexStats()).toMatchObject({
			messageCount: 0,
			chunkCount: 0,
			embeddedChunkCount: 0,
		});
		await manager.close();
	});

	it("keeps an all-zero caller vector out of the semantic child index", async () => {
		const manager = new SQLiteRawMessageManager({ dbPath: join(scratchDir, "store.db") });
		await manager.storeMessage({ ...longMessage(), content: "short text", embedding: [0, 0, 0] });

		expect(await manager.getRawMessageSearchIndexStats()).toMatchObject({
			chunkCount: 1,
			embeddedChunkCount: 0,
			semanticReady: false,
			lexicalReady: true,
		});
		expect(
			await manager.searchMessagesSemantically({ userId: "user", queryEmbedding: [1, 0, 0], limit: 8 }),
		).toEqual([]);
		await manager.close();
	});
});
