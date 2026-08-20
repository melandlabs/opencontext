import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LanceDBStore } from "./lancedb-store";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("LanceDBStore", () => {
	it("upserts chunks and performs filtered dense, BM25, and weighted hybrid search", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencontext-lance-"));
		directories.push(directory);
		const store = new LanceDBStore({ uri: directory, defaultFusion: "weighted" });

		await store.addChunks([
			{
				id: "chunk-1",
				documentId: "doc-1",
				content: "Project Northstar deadline planning",
				embedding: [1, 0, 0],
				metadata: { userId: "alice", kind: "plan" },
			},
			{
				id: "chunk-2",
				documentId: "doc-2",
				content: "Northstar production incident",
				embedding: [0, 1, 0],
				metadata: { userId: "bob" },
			},
		]);

		expect(await store.getChunkCount()).toBe(2);
		expect(await store.getDocumentCount()).toBe(2);
		expect(await store.similaritySearch([1, 0, 0], 1, "alice")).toEqual([
			expect.objectContaining({ id: "chunk-1", documentId: "doc-1" }),
		]);

		const lexical = await store.hybridSearch({
			text: "incident",
			limit: 5,
			filter: { userId: "bob" },
		});
		expect(lexical.map(({ id }) => id)).toEqual(["chunk-2"]);

		const hybrid = await store.hybridSearch({
			text: "Northstar",
			vector: [1, 0, 0],
			fusion: "weighted",
			alpha: 0.8,
			limit: 2,
		});
		expect(hybrid[0].id).toBe("chunk-1");
		const rrf = await store.hybridSearch({
			text: "Northstar",
			vector: [1, 0, 0],
			fusion: "rrf",
			limit: 2,
		});
		expect(rrf).toHaveLength(2);
		expect(rrf[0].score).toBeGreaterThan(0);

		await store.addChunk({
			id: "chunk-1",
			documentId: "doc-1",
			content: "Updated Project Northstar deadline",
			embedding: [1, 0, 0],
			metadata: { userId: "alice", updated: true },
		});
		expect(await store.getChunkCount()).toBe(2);

		await store.deleteDocument("doc-2");
		expect(await store.getChunkCount()).toBe(1);
		await store.close();

		const reopened = new LanceDBStore({ uri: directory });
		await expect(reopened.similaritySearch([1, 0], 1)).rejects.toThrow("store dimension 3");
		await reopened.clear();
		expect(await reopened.getChunkCount()).toBe(0);
		await reopened.close();
	});
});
