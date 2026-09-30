import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startHttpServer } from "./http";
import { __resetSQLiteRawMessageManagerForTests } from "./storage/sqlite-raw-message-store";

const transport = vi.hoisted(() => ({
	fetch: undefined as undefined | ((request: Request) => Promise<Response>),
}));
vi.mock("@hono/node-server", () => ({
	serve: (options: { fetch: (request: Request) => Promise<Response> }) => {
		transport.fetch = options.fetch;
		return { close: (done: () => void) => done() };
	},
}));

it("HTTP ingest and search expose core numbering and explanations without changing stored text", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "message-sequence-http-"));
	vi.stubEnv("MEMORY_STORE_DB_PATH", join(scratch, "store.db"));
	vi.stubEnv("OPENCONTEXT_MEMORY_STORE_BACKEND", "sqlite");
	__resetSQLiteRawMessageManagerForTests();
	const rerank = vi.fn(async () => [
		{ id: "new", score: 0.99 },
		{ id: "old", score: 0.8 },
	]);
	const server = await startHttpServer({ port: 0, unified: { reranker: { rerank } } });
	try {
		const request = async (path: string, body?: unknown) => {
			const response = await transport.fetch?.(
				new Request(
					`http://localhost${path}`,
					body === undefined
						? undefined
						: {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify(body),
							},
				),
			);
			expect(response?.status).toBe(200);
			return response?.json();
		};
		await request("/v1/raw-messages", {
			userId: "alice",
			embedOnInsert: false,
			messages: [
				{
					messageId: "old",
					platform: "chat",
					botId: "bot",
					content: "Shanghai was my home.",
					timestamp: 123,
					createdAt: 1,
				},
				{
					messageId: "new",
					platform: "chat",
					botId: "bot",
					content: "Shanghai is still my home.",
					createdAt: 2,
				},
			],
		});
		const { message } = await request("/v1/raw-messages/new?userId=alice");
		expect(message).toMatchObject({ messageSequence: 2, content: "Shanghai is still my home." });
		expect(message).not.toHaveProperty("timestamp");
		const output = await request("/v1/search", {
			userId: "alice",
			query: "Shanghai",
			sources: ["memory"],
			limit: 2,
			includeRetrievalDiagnostics: true,
		});
		expect(output.results.map((hit: { id: string }) => hit.id)).toEqual(["new", "old"]);
		const [newHit, oldHit] = output.results;
		expect(oldHit.metadata).toMatchObject({
			messageSequence: 1,
			timestamp: 123000,
			sourceChunkIndex: 0,
		});
		expect(newHit.content).toContain("messageSequence: 2");
		expect(newHit.content).toContain("Historical facts retain their original meaning.");
		expect(newHit.metadata).not.toHaveProperty("timestamp");
		expect(output.retrievalDiagnostics.reranker.enabled).toBe(true);
		expect(rerank).toHaveBeenCalledOnce();
	} finally {
		await server.stop();
		__resetSQLiteRawMessageManagerForTests();
		vi.unstubAllEnvs();
		rmSync(scratch, { recursive: true, force: true });
	}
});
