import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
				embedding: index === 1 ? [1, 0, 0] : [0, 1, 0],
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
