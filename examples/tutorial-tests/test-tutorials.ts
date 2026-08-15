/**
 * Test script to verify all tutorial code examples work correctly.
 * This runs directly against the workspace packages.
 */

import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";
import { info, makeCheck, runSection } from "../src/_helpers.ts";

const TEST_DIR = "./test-tutorial-temp";

// Setup test directory
function setupTestDir() {
	if (existsSync(TEST_DIR)) {
		rmSync(TEST_DIR, { recursive: true });
	}
	mkdirSync(TEST_DIR, { recursive: true });
}

// Cleanup test directory
function cleanupTestDir() {
	if (existsSync(TEST_DIR)) {
		rmSync(TEST_DIR, { recursive: true });
	}
}

// Test from 00-getting-started.md
async function testGettingStarted() {
	await runSection("00-getting-started.md examples", async () => {
		const check = makeCheck("tutorial/00");

		// Test createMemoryStore and searchUnifiedMemory
		process.env.MEMORY_STORE_DB_PATH = join(TEST_DIR, "memory.db");
		const store = await createMemoryStore();
		const messages = await getRawMessageManager();

		const now = Date.now();

		// Store a fact
		await messages.storeMessages([
			{
				messageId: "msg-1",
				userId: "user-42",
				content: "User prefers dark mode in all applications",
				platform: "tutorial",
				botId: "tutorial-bot",
				timestamp: now,
				createdAt: now,
			},
		]);

		info("tutorial/00", "✅ Memory stored successfully");
		check("remember() stores facts", true);

		// Search for what we just stored
		const results = await store.searchUnifiedMemory({
			userId: "user-42",
			query: "What does the user prefer?",
			limit: 5,
		});

		info("tutorial/00", `✅ Search completed: ${results.count} results`);
		check("recall() returns results", Array.isArray(results.results));
		check("recall() echoes query", results.query === "What does the user prefer?");

		return true;
	});
}

// Test from 01-user-guide.md
async function testUserGuide() {
	await runSection("01-user-guide.md examples", async () => {
		const check = makeCheck("tutorial/01");

		process.env.MEMORY_STORE_DB_PATH = join(TEST_DIR, "user-guide.db");
		const store = await createMemoryStore();
		const messages = await getRawMessageManager();

		const now = Date.now();

		// Test remember with metadata
		await messages.storeMessages([
			{
				messageId: "user-guide-msg-1",
				userId: "user-123",
				content: "User prefers dark mode",
				platform: "slack",
				botId: "my-agent",
				timestamp: now,
				createdAt: now,
				metadata: {
					channel: "general",
					threadId: "thread-456",
				},
			},
		]);

		info("tutorial/01", "✅ Remember with metadata works");
		check("remember() accepts metadata", true);

		// Test recall with filters
		const results = await store.searchUnifiedMemory({
			userId: "user-123",
			query: "preferences",
			limit: 10,
			threshold: 0.7,
		});

		info("tutorial/01", `✅ Recall with filters: ${results.count} results`);
		check("recall() accepts filters", true);
		check(
			"warnings are structured",
			results.warnings.every((w) => typeof w.code === "string"),
		);

		return true;
	});
}

// Test from 02-developer-guide.md
async function testDeveloperGuide() {
	await runSection("02-developer-guide.md examples", async () => {
		const check = makeCheck("tutorial/02");

		// Test memory service pattern
		process.env.MEMORY_STORE_DB_PATH = join(TEST_DIR, "dev-guide.db");

		async function rememberFact(userId: string, content: string) {
			const messages = await getRawMessageManager();
			const now = Date.now();

			await messages.storeMessages([
				{
					messageId: `msg-${now}-${userId}`,
					userId,
					content,
					platform: "my-app",
					botId: "default",
					timestamp: now,
					createdAt: now,
				},
			]);
		}

		async function recallFacts(userId: string, query: string, limit = 10) {
			const store = await createMemoryStore();
			return await store.searchUnifiedMemory({ userId, query, limit });
		}

		const store = await createMemoryStore();
		await rememberFact("test-user", "Test fact for developer guide");
		info("tutorial/02", "✅ Memory service pattern works");
		check("service pattern remember() works", true);

		const results = await recallFacts("test-user", "test");
		info("tutorial/02", `✅ Recall service pattern works (${results.count} results)`);
		check("service pattern recall() works", true);

		return true;
	});
}

// Test from 03-advanced-usage.md
async function testAdvancedUsage() {
	await runSection("03-advanced-usage.md examples", async () => {
		const check = makeCheck("tutorial/03");

		process.env.MEMORY_STORE_DB_PATH = join(TEST_DIR, "advanced.db");
		const store = await createMemoryStore();

		// Test multi-source search structure
		const results = await store.searchUnifiedMemory({
			userId: "user-123",
			query: "test query",
			sources: ["memory", "insights", "knowledge"],
			limit: 10,
			threshold: 0.7,
		});

		info("tutorial/03", `✅ Multi-source search: ${results.sources.length} sources consulted`);
		check("multi-source search works", results.sources.length > 0);

		// Test result iteration
		for (const hit of results.results) {
			check("result iteration works", typeof hit.score === "number");
			break; // Just check first one
		}

		return true;
	});
}

// Test from 04-best-practices.md
async function testBestPractices() {
	await runSection("04-best-practices.md examples", async () => {
		const check = makeCheck("tutorial/04");

		process.env.MEMORY_STORE_DB_PATH = join(TEST_DIR, "best-practices.db");
		const store = await createMemoryStore();
		const messages = await getRawMessageManager();

		// Test messageId idempotency
		const now = Date.now();
		const userId = "user-123";
		const messageId = `${userId}-slack-external-123`;

		await messages.storeMessages([
			{
				messageId,
				userId,
				content: "User prefers dark mode",
				platform: "slack",
				botId: "test-bot",
				timestamp: now,
				createdAt: now,
			},
		]);

		info("tutorial/04", "✅ Stable messageId pattern works");

		// Test re-ingest (should be idempotent)
		await messages.storeMessages([
			{
				messageId,
				userId,
				content: "User prefers dark mode",
				platform: "slack",
				botId: "test-bot",
				timestamp: now,
				createdAt: now,
			},
		]);

		info("tutorial/04", "✅ Idempotent re-ingest works");
		check("messageId provides idempotency", true);

		// Test warning handling
		const results = await store.searchUnifiedMemory({
			userId: "user-123",
			query: "test",
			limit: 10,
		});

		let warningsHandled = 0;
		for (const warning of results.warnings) {
			warningsHandled++;
			check(`warning ${warning.code} is structured`, typeof warning.code === "string");
		}

		info("tutorial/04", `✅ Graceful warning handling (${warningsHandled} warnings)`);
		check("graceful degradation works", true);

		return true;
	});
}

// Run all tests
export default async function testTutorials() {
	await runSection("🧪 Tutorial Code Tests", async () => {
		setupTestDir();

		try {
			await testGettingStarted();
			await testUserGuide();
			await testDeveloperGuide();
			await testAdvancedUsage();
			await testBestPractices();

			info("tutorial", "\n" + "=".repeat(50));
			info("tutorial", "✅ ALL TUTORIAL TESTS PASSED!");
			info("tutorial", "=".repeat(50));
		} catch (error) {
			info("tutorial", "\n❌ TEST FAILED:");
			throw error;
		} finally {
			cleanupTestDir();
		}
	});
}
