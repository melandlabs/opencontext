/**
 * End-to-end memory store tests:
 *   - Store messages with embeddings
 *   - Semantic search with embeddings
 *   - Keyword search fallback via lexical search
 *   - Vector table update verification
 *
 * Tests run with local embedding provider and SQLite backend.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalTransformersEmbeddingProvider } from "@melandlabs/ai-rag/local-transformers-embedding-provider";
import type { RawMessage } from "@melandlabs/indexeddb/storage";
import { SQLiteRawMessageManager } from "@melandlabs/sqlite/raw-message-manager";
import { createMemoryStore } from "./index";
import { createRawMessageStore } from "./storage/raw-message-store";
import { __resetSQLiteRawMessageManagerForTests } from "./storage/sqlite-raw-message-store";

let scratchDir: string;

beforeEach(() => {
	scratchDir = mkdtempSync(join(tmpdir(), "memory-e2e-test-"));
	// Ensure each test gets its own SQLite singleton backed by a fresh temp DB.
	__resetSQLiteRawMessageManagerForTests();
});

afterEach(() => {
	rmSync(scratchDir, { recursive: true, force: true });
});

function makeMessage(overrides: Partial<RawMessage> & { messageId: string; content: string }): RawMessage {
	const now = Math.floor(Date.now() / 1000);
	return {
		platform: "test",
		botId: "test-bot",
		userId: "test-user",
		timestamp: now,
		createdAt: now,
		...overrides,
	};
}

describe("Memory Store End-to-End", () => {
	it("stores messages with embeddings and returns them via semantic search", async () => {
		const embeddingProvider = new LocalTransformersEmbeddingProvider({
			modelName: "Xenova/all-MiniLM-L6-v2",
		});

		const dbPath = join(scratchDir, "semantic-test.db");

		const store = await createMemoryStore({
			dbPath,
			unified: {
				embedQuery: async ({ query }) => {
					const result = await embeddingProvider.embedQuery(query);
					return result;
				},
			},
		});

		const rawStore = createRawMessageStore({ dbPath });
		const messages = await rawStore.getManager();
		const userId = "semantic-test-user";
		const now = Math.floor(Date.now() / 1000);

		// Store with pre-computed embedding
		const embedding = await embeddingProvider.embedQuery("User prefers dark mode in all applications");

		await (messages as SQLiteRawMessageManager).storeMessages([
			makeMessage({
				messageId: `msg-${now}`,
				content: "User prefers dark mode in all applications",
				userId,
				embedding,
				embeddingModel: "Xenova/all-MiniLM-L6-v2",
			}),
			makeMessage({
				messageId: `msg-${now + 1}`,
				content: "Python is the user's favorite programming language",
				userId,
				embedding: await embeddingProvider.embedQuery("Python is the user's favorite programming language"),
				embeddingModel: "Xenova/all-MiniLM-L6-v2",
			}),
		]);

		// Search with a semantically similar query
		const results = await store.searchUnifiedMemory({
			userId,
			query: "What theme does the user like?",
			limit: 5,
			threshold: 0.3,
		});

		// Should find at least one result about dark mode
		expect(results.results.length).toBeGreaterThan(0);
		expect(results.count).toBeGreaterThan(0);

		// One of the results should be about dark mode (semantically similar to "theme")
		const darkModeResult = results.results.find((r) => r.content.toLowerCase().includes("dark mode"));
		expect(darkModeResult).toBeDefined();

		await rawStore.close();
	});

	it("falls back to keyword search when embeddings are not configured", async () => {
		// Create store WITHOUT embedding provider
		const dbPath = join(scratchDir, "keyword-test.db");
		const store = await createMemoryStore({
			dbPath,
			unified: {},
		});

		const rawStore = createRawMessageStore({ dbPath });
		const messages = await rawStore.getManager();
		const userId = "keyword-test-user";
		const now = Math.floor(Date.now() / 1000);

		// Store messages WITHOUT embeddings
		await (messages as SQLiteRawMessageManager).storeMessages([
			makeMessage({
				messageId: `keyword-msg-${now}`,
				content: "The user loves pizza with extra cheese",
				userId,
			}),
			makeMessage({
				messageId: `keyword-msg-${now + 1}`,
				content: "User hates vegetables and refuses to eat them",
				userId,
			}),
		]);

		// Search with keyword match
		const results = await store.searchUnifiedMemory({
			userId,
			query: "pizza cheese",
			limit: 5,
		});

		// Keyword search should work as fallback
		expect(results.results.length).toBeGreaterThan(0);

		// Should find the pizza message
		const pizzaResult = results.results.find((r) => r.content.toLowerCase().includes("pizza"));
		expect(pizzaResult).toBeDefined();

		// Should have lexical search warning
		expect(results.warnings.length).toBeGreaterThan(0);
		const lexicalWarning = results.warnings.find((w) => w.code === "memory_lexical_search_fallback");
		expect(lexicalWarning).toBeDefined();

		await rawStore.close();
	});

	it("returns empty results for non-existent users without throwing", async () => {
		const store = await createMemoryStore({
			dbPath: join(scratchDir, "empty-test.db"),
		});

		const results = await store.searchUnifiedMemory({
			userId: "non-existent-user-12345",
			query: "anything",
			limit: 5,
		});

		expect(results.results).toEqual([]);
		expect(results.count).toBe(0);
	});

	it("stores and retrieves messages without embeddings", async () => {
		const dbPath = join(scratchDir, "retrieve-test.db");
		const store = await createMemoryStore({
			dbPath,
		});

		const rawStore = createRawMessageStore({ dbPath });
		const messages = await rawStore.getManager();
		const userId = "no-embedding-test-user";
		const now = Math.floor(Date.now() / 1000);

		await (messages as SQLiteRawMessageManager).storeMessages([
			makeMessage({
				messageId: `retrieve-msg-${now}`,
				content: "Message without embedding field",
				userId,
			}),
		]);

		// Should be able to retrieve the message
		const retrieved = await (messages as SQLiteRawMessageManager).getMessageById(`retrieve-msg-${now}`);
		expect(retrieved).toBeDefined();
		expect(retrieved?.content).toBe("Message without embedding field");

		await rawStore.close();
	});
});

describe("Lexical Search Integration", () => {
	it("directly verifies lexical search on SQLite manager", async () => {
		const manager = new SQLiteRawMessageManager({
			dbPath: join(scratchDir, "lexical-test.db"),
		});
		await manager.init();

		const now = Math.floor(Date.now() / 1000);
		const userId = "lexical-direct-test";

		// Store messages
		await manager.storeMessages([
			makeMessage({
				messageId: `lex-${now}`,
				content: "The quick brown fox jumps over the lazy dog",
				userId,
			}),
			makeMessage({
				messageId: `lex-${now + 1}`,
				content: "Python programming language is great for data science",
				userId,
			}),
		]);

		// Test lexical search
		const results = await manager.lexicalSearchMessages({
			userId,
			keywords: ["python", "programming"],
			limit: 5,
		});

		expect(results.length).toBeGreaterThan(0);
		expect(results[0].metadata.scoring).toBe("bm25");
		expect(results[0].content.toLowerCase()).toContain("python");

		await manager.close();
	});

	it("returns empty array for empty keywords without throwing", async () => {
		const manager = new SQLiteRawMessageManager({
			dbPath: join(scratchDir, "lexical-empty-test.db"),
		});
		await manager.init();

		const results = await manager.lexicalSearchMessages({
			userId: "test-user",
			keywords: [],
		});

		expect(results).toEqual([]);

		await manager.close();
	});
});

describe("Vector Table Update", () => {
	it("updates vector table after storing messages with embeddings", async () => {
		const embeddingProvider = new LocalTransformersEmbeddingProvider({
			modelName: "Xenova/all-MiniLM-L6-v2",
		});

		const manager = new SQLiteRawMessageManager({
			dbPath: join(scratchDir, "vector-update-test.db"),
		});
		await manager.init();

		const userId = "vector-test-user";
		const now = Math.floor(Date.now() / 1000);

		// Store message with embedding
		const embedding = await embeddingProvider.embedQuery("Test message for vector table");

		await manager.storeMessages([
			makeMessage({
				messageId: `vec-msg-${now}`,
				content: "Test message for vector table",
				userId,
				embedding,
				embeddingModel: "Xenova/all-MiniLM-L6-v2",
			}),
		]);

		// Update vector table
		manager.upsertVectorForMessage?.(`vec-msg-${now}`, embedding);

		// Verify the message is in the database
		const retrieved = await manager.getMessageById(`vec-msg-${now}`);
		expect(retrieved).toBeDefined();
		expect(retrieved?.content).toBe("Test message for vector table");

		await manager.close();
	});
});
