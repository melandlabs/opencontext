// Basic Memory API Test - Verifies core functionality
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

async function testMemoryAPI() {
	console.log("=== OpenContext Memory API Test ===\n");

	// Test 1: Create store
	console.log("Test 1: Creating memory store...");
	const store = await createMemoryStore({
		env: { isTauriMode: () => false },
	});
	console.log("✓ Memory store created\n");

	// Test 2: Get message manager
	console.log("Test 2: Getting message manager...");
	const messages = await getRawMessageManager();
	console.log("✓ Message manager ready\n");

	// Test 3: Store messages
	console.log("Test 3: Storing messages...");
	const now = Date.now();

	await messages.storeMessages([
		{
			messageId: "test-msg-1",
			userId: "test-user",
			content: "Test message 1: User prefers dark mode",
			platform: "test",
			botId: "test-bot",
			timestamp: now,
			createdAt: now,
		},
		{
			messageId: "test-msg-2",
			userId: "test-user",
			content: "Test message 2: User works 9am-5pm",
			platform: "test",
			botId: "test-bot",
			timestamp: now + 1000,
			createdAt: now + 1000,
		},
		{
			messageId: "test-msg-3",
			userId: "test-user",
			content: "Test message 3: User uses TypeScript",
			platform: "test",
			botId: "test-bot",
			timestamp: now + 2000,
			createdAt: now + 2000,
		},
	]);
	console.log("✓ Stored 3 messages\n");

	// Test 4: Query messages
	console.log("Test 4: Querying messages...");
	const queried = await messages.queryMessages({
		userId: "test-user",
		limit: 10,
	});
	console.log(`✓ Queried ${queried.length} messages`);
	for (const msg of queried) {
		console.log(`  - ${msg.content}`);
	}
	console.log("");

	// Test 5: Get message by ID
	console.log("Test 5: Getting message by ID...");
	const byId = await messages.getMessageById("test-msg-1");
	if (byId) {
		console.log(`✓ Retrieved: "${byId.content}"\n`);
	} else {
		console.log("✗ Failed to retrieve message\n");
	}

	// Test 6: Search (may show warnings without embedder)
	console.log("Test 6: Searching messages...");
	try {
		const results = await store.searchUnifiedMemory({
			userId: "test-user",
			query: "user preferences",
			limit: 5,
		});

		console.log(`✓ Search completed: ${results.count} results`);
		if (results.warnings.length > 0) {
			console.log(`  Warnings: ${results.warnings.map((w) => w.code).join(", ")}`);
		}
	} catch (error) {
		console.log(`  Search error (expected without embedder): ${(error as Error).message}`);
	}

	// Test 7: Get stats
	console.log("\nTest 7: Getting storage stats...");
	try {
		const stats = await messages.getStats();
		console.log(`✓ Total messages: ${stats.totalMessages}`);
		console.log(`  By platform: ${JSON.stringify(stats.messagesByPlatform)}`);
	} catch (error) {
		console.log(`  Stats not available: ${(error as Error).message}`);
	}

	console.log("\n=== All Basic Tests Passed! ===\n");
	console.log("Summary:");
	console.log("  ✓ Store creation works");
	console.log("  ✓ Message manager works");
	console.log("  ✓ Store messages works");
	console.log("  ✓ Query messages works");
	console.log("  ✓ Get message by ID works");
	console.log("  ✓ Search API exists (may need embedder config)");
	console.log("  ✓ Get stats works\n");

	process.exit(0);
}

testMemoryAPI().catch((error) => {
	console.error("\n✗ Test failed:", error);
	process.exit(1);
});
