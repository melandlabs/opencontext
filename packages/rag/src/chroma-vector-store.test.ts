import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromaVectorStore } from "./chroma-vector-store";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ChromaVectorStore", () => {
	it("upserts child content while retaining the parent documentId", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const store = new ChromaVectorStore({ url: "http://chroma.test/", collectionName: "raw children" });

		await store.addChunk({
			id: "message-1:0",
			documentId: "message-1",
			content: "child content",
			embedding: [1, 0],
			metadata: { userId: "user-1" },
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://chroma.test/api/v1/collections/raw%20children/upsert");
		expect(JSON.parse(String(init.body))).toEqual({
			ids: ["message-1:0"],
			embeddings: [[1, 0]],
			documents: ["child content"],
			metadatas: [{ userId: "user-1", documentId: "message-1" }],
		});
	});

	it("queries by user and converts Chroma distance to a similarity score", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				ids: [["message-1:0"]],
				documents: [["child content"]],
				metadatas: [[{ documentId: "message-1", userId: "user-1" }]],
				distances: [[0.25]],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const store = new ChromaVectorStore({ url: "http://chroma.test", collectionName: "children" });

		const results = await store.similaritySearch([1, 0], 8, "user-1");

		expect(results).toEqual([
			{
				id: "message-1:0",
				documentId: "message-1",
				content: "child content",
				score: 0.8,
				metadata: { documentId: "message-1", userId: "user-1" },
			},
		]);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toMatchObject({ n_results: 8, where: { userId: "user-1" } });
	});

	it("deletes every child belonging to a parent document", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const store = new ChromaVectorStore({ url: "http://chroma.test", collectionName: "children" });

		await store.deleteDocument("message-1");

		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toEqual({ where: { documentId: "message-1" } });
	});
});
