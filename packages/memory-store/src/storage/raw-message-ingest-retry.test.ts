import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawMessage, RawMessageSearchChunk } from "@melandlabs/indexeddb";
import { describe, expect, it, vi } from "vitest";
import { SQLiteRawMessageManager } from "../../../sqlite/src/raw-message-manager";
import { prepareRawMessageIngest } from "../embed-on-insert";
import { persistRawMessages } from "./raw-message-ingest";

const message = (overrides: Partial<RawMessage> = {}): RawMessage => ({
	messageId: "retry-parent",
	userId: "alice",
	botId: "bot",
	platform: "chat",
	createdAt: 1,
	content: "Original message.",
	...overrides,
});
const embeddingInfo = { model: "fixture-v1", dimensions: 2 };
const embedDocuments = () => vi.fn(async ({ texts }: { texts: string[] }) => texts.map(() => [1, 2]));

describe("persisted child embedding reuse", () => {
	it("reuses every long-message child without calling the provider or dropping new metadata", async () => {
		const incoming = message({ content: "A sentence containing historical evidence. ".repeat(150) });
		const embed = embedDocuments();
		const original = await prepareRawMessageIngest([incoming], true, {
			embedDocuments: embed,
			embeddingInfo,
		});
		expect(original.chunks.length).toBeGreaterThan(1);
		embed.mockClear();
		const retry = await prepareRawMessageIngest(
			[{ ...incoming, timestamp: 123, metadata: { revision: 2 } }],
			true,
			{ embedDocuments: embed, embeddingInfo },
			original.chunks,
		);
		expect(embed).not.toHaveBeenCalled();
		expect(retry.chunks).toEqual(original.chunks);
		expect(retry.messages[0]).toMatchObject({ timestamp: 123, metadata: { revision: 2 } });
		expect(retry.warnings).toEqual([]);
	});

	it.each([
		["different user", { userId: "bob" }],
		["different message", { messageId: "other" }],
		["different model", { embeddingModel: "fixture-v2" }],
		["missing model", { embeddingModel: undefined }],
		["changed text", { content: "Changed text" }],
		["corrupt hash", { contentHash: "invalid" }],
		["changed offset", { startPosition: 1 }],
		["wrong dimensions", { embedding: [1, 2, 3], embeddingDimensions: 3 }],
		["inconsistent dimensions", { embeddingDimensions: 3 }],
		["missing vector", { embedding: undefined }],
		["zero vector", { embedding: [0, 0] }],
		["nonfinite vector", { embedding: [1, Number.NaN] }],
	] satisfies Array<[string, Partial<RawMessageSearchChunk>]>)(
		"regenerates a child with %s",
		async (_, patch) => {
			const incoming = message();
			const embed = embedDocuments();
			const original = await prepareRawMessageIngest([incoming], true, {
				embedDocuments: embed,
				embeddingInfo,
			});
			embed.mockClear();
			const firstChunk = original.chunks[0];
			if (!firstChunk) throw new Error("Fixture did not produce a chunk");
			const result = await prepareRawMessageIngest(
				[incoming],
				true,
				{ embedDocuments: embed, embeddingInfo },
				[{ ...firstChunk, ...patch }],
			);
			expect(embed).toHaveBeenCalledOnce();
			expect(result.chunks[0]?.embedding).toEqual([1, 2]);
		},
	);

	it("does not reuse catalog vectors when the active model identity is unknown", async () => {
		const incoming = message();
		const embed = embedDocuments();
		const original = await prepareRawMessageIngest([incoming], true, {
			embedDocuments: embed,
			embeddingInfo,
		});
		embed.mockClear();
		await prepareRawMessageIngest([incoming], true, { embedDocuments: embed }, original.chunks);
		expect(embed).toHaveBeenCalledOnce();
	});

	it("embeds only missing children and newly submitted messages in a mixed batch", async () => {
		const incoming = message({ content: "A longer paragraph for child chunking. ".repeat(150) });
		const embed = embedDocuments();
		const original = await prepareRawMessageIngest([incoming], true, {
			embedDocuments: embed,
			embeddingInfo,
		});
		embed.mockClear();
		const newMessage = message({ messageId: "new-parent", content: "New message" });
		const result = await prepareRawMessageIngest(
			[incoming, newMessage],
			true,
			{ embedDocuments: embed, embeddingInfo },
			original.chunks.slice(1),
		);
		expect(embed).toHaveBeenCalledOnce();
		expect(embed).toHaveBeenCalledWith({
			userId: "alice",
			texts: [original.chunks[0]?.content, "New message"],
		});
		expect(result.chunks).toHaveLength(original.chunks.length + 1);
	});

	it("uses user-scoped bounded catalog reads and still repairs the external index", async () => {
		const incoming = message();
		const embed = embedDocuments();
		const original = await prepareRawMessageIngest([incoming], true, {
			embedDocuments: embed,
			embeddingInfo,
		});
		embed.mockClear();
		const manager = {
			getRawMessageSearchChunks: vi.fn(async () => original.chunks),
			storeMessagesWithSearchChunks: vi.fn(async () => [1]),
		};
		const externalIndex = { replaceMessages: vi.fn(async () => undefined) };
		await persistRawMessages({
			manager,
			userId: "alice",
			messages: [incoming],
			embedOnInsert: true,
			unified: { embedDocuments: embed, embeddingInfo },
			externalIndex,
		});
		expect(manager.getRawMessageSearchChunks).toHaveBeenCalledOnce();
		expect(manager.getRawMessageSearchChunks).toHaveBeenCalledWith({
			userId: "alice",
			messageIds: [incoming.messageId],
		});
		expect(embed).not.toHaveBeenCalled();
		expect(externalIndex.replaceMessages).toHaveBeenCalledOnce();
		expect(manager.storeMessagesWithSearchChunks).toHaveBeenCalledOnce();
		manager.getRawMessageSearchChunks.mockClear();
		await persistRawMessages({ manager, userId: "alice", messages: [], unified: { embeddingInfo } });
		expect(manager.getRawMessageSearchChunks).not.toHaveBeenCalled();
	});

	it("reuses SQLite vectors after restart and retains sequence, timestamps, metadata, and searchability", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "raw-message-retry-"));
		const dbPath = join(scratch, "store.sqlite");
		let manager = new SQLiteRawMessageManager({ dbPath });
		const embed = embedDocuments();
		const unified = { embedDocuments: embed, embeddingInfo };
		const incoming = [
			message(),
			message({ messageId: "second", timestamp: 456, content: "A long evidence sentence. ".repeat(150) }),
		];
		try {
			await persistRawMessages({
				manager,
				userId: "alice",
				messages: incoming,
				embedOnInsert: true,
				unified,
			});
			const original = await manager.getRawMessageSearchChunks({ userId: "alice" });
			await manager.close();
			manager = new SQLiteRawMessageManager({ dbPath });
			embed.mockClear();
			await persistRawMessages({
				manager,
				userId: "alice",
				messages: incoming.map((m) => ({ ...m, createdAt: 999, metadata: { retried: true } })),
				embedOnInsert: true,
				unified,
			});
			expect(embed).not.toHaveBeenCalled();
			expect(await manager.getRawMessageSearchChunks({ userId: "alice" })).toEqual(original);
			expect(await manager.getMessageById("retry-parent")).toMatchObject({
				messageSequence: 1,
				metadata: { retried: true },
			});
			expect((await manager.getMessageById("retry-parent"))?.timestamp).toBeUndefined();
			expect(await manager.getMessageById("second")).toMatchObject({ messageSequence: 2, timestamp: 456 });
			expect(await manager.getRawMessageSearchIndexStats()).toMatchObject({
				messageCount: 2,
				chunkCount: original.length,
				embeddedChunkCount: original.length,
				semanticReady: true,
			});
			const hits = await manager.searchMessagesSemantically({
				userId: "alice",
				queryEmbedding: [1, 2],
				limit: 2,
			});
			expect(hits).toHaveLength(2);
			await persistRawMessages({
				manager,
				userId: "alice",
				messages: [message({ content: "Updated content" })],
				embedOnInsert: true,
				unified,
			});
			expect(embed).toHaveBeenCalledOnce();
			expect(await manager.getMessageById("retry-parent")).toMatchObject({
				messageSequence: 1,
				content: "Updated content",
			});
		} finally {
			await manager.close();
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
