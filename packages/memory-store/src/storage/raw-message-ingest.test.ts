import type { RawMessage, RawMessageSearchChunk } from "@melandlabs/indexeddb";
import { describe, expect, it, vi } from "vitest";
import { persistRawMessages } from "./raw-message-ingest";

describe("persistRawMessages", () => {
	it("uses one shared parent/child write contract for transport callers and external indexes", async () => {
		const message: RawMessage = {
			messageId: "message-1",
			userId: "user-1",
			botId: "bot-1",
			platform: "test",
			timestamp: 1,
			createdAt: 1,
			content: Array.from({ length: 300 }, (_, index) => `Sentence ${index}.`).join(" "),
		};
		let storedMessages: RawMessage[] = [];
		let storedChunks: RawMessageSearchChunk[] = [];
		const manager = {
			storeMessagesWithSearchChunks: vi.fn(
				async (messages: RawMessage[], chunks: RawMessageSearchChunk[]) => {
					storedMessages = messages;
					storedChunks = chunks;
					return [1];
				},
			),
		};
		const externalIndex = { replaceMessages: vi.fn(async () => undefined) };
		const embedQuery = vi.fn(async ({ query }: { query: string }) => [query.length, 1]);

		const result = await persistRawMessages({
			manager,
			userId: message.userId,
			messages: [message],
			embedOnInsert: true,
			unified: { embedQuery, embeddingInfo: { provider: "fixture", model: "fixture-embedding" } },
			externalIndex,
		});

		expect(storedMessages).toHaveLength(1);
		expect(storedMessages[0]?.content).toBe(message.content);
		expect(storedChunks.length).toBeGreaterThan(1);
		expect(embedQuery).toHaveBeenCalledTimes(storedChunks.length);
		expect(storedChunks.every((chunk) => chunk.messageId === message.messageId)).toBe(true);
		expect(storedChunks.every((chunk) => chunk.embeddingModel === "fixture-embedding")).toBe(true);
		expect(externalIndex.replaceMessages).toHaveBeenCalledWith(storedMessages, storedChunks);
		expect(result).toMatchObject({ count: 1, ids: [1], warnings: [] });
	});
});
