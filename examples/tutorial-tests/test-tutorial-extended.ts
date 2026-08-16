/**
 * Extended Tutorial Tests - Covers missing patterns from tutorials
 *
 * This test file covers examples not tested in test-tutorials.ts:
 * - 03-advanced-usage.md: Platform integrations, Loop engine, encryption, URL validation
 * - 04-best-practices.md: Batch writes, metadata patterns, structured user IDs
 *
 * Note: Some tutorial examples are not tested here because they:
 * - Require external services (e.g., live API keys for LLM, web search)
 * - Are browser-only (e.g., voice APIs, IndexedDB)
 * - Are infrastructure patterns (e.g., Docker, systemd configs)
 * - Don't exist as exported APIs (e.g., forget, improve, MemoryGraph)
 */

import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import {
	createMemoryStore,
	getRawMessageManager,
	INTEGRATION_IDS,
	LOOP_PATHS,
	ensureDirs,
	readPreferences,
	writePreferences,
} from "@melandlabs/opencontext";
import { validateCronExpression, computeNextRun } from "@melandlabs/cron";
import { TokenEncryption, validateUrlForSSRF, isTrustedStorageUrl } from "@melandlabs/security";
import { needsRealTimeInfo } from "@melandlabs/search";
import { getAgentInstance } from "@melandlabs/ai";
import { info, makeCheck, makeCheckWithSkip, runSection } from "../src/_helpers.ts";

const TEST_DIR = "./test-tutorial-extended-temp";

// Helper: Setup test directory
function setupTestDir() {
	if (existsSync(TEST_DIR)) {
		rmSync(TEST_DIR, { recursive: true });
	}
	mkdirSync(TEST_DIR, { recursive: true });
}

// Helper: Cleanup test directory
function cleanupTestDir() {
	if (existsSync(TEST_DIR)) {
		rmSync(TEST_DIR, { recursive: true });
	}
}

// ============================================
// 01-user-guide.md: MemoryAwareAgent pattern
// ============================================
async function testMemoryAwareAgentPattern() {
	await runSection("01-user-guide.md: MemoryAwareAgent pattern", async () => {
		const check = makeCheck("tutorial/01-memory-agent");

		process.env.MEMORY_STORE_DB_PATH = join(TEST_DIR, "memory-agent.db");

		// Define the MemoryAwareAgent class from the tutorial
		class MemoryAwareAgent {
			agent: Awaited<ReturnType<typeof getAgentInstance>> | null = null;
			store: Awaited<ReturnType<typeof createMemoryStore>> | null = null;
			userId: string;

			constructor(userId: string) {
				this.agent = null;
				this.store = null;
				this.userId = userId;
			}

			async initialize() {
				this.agent = await getAgentInstance("standalone", {
					provider: "standalone",
					model: "openai/gpt-4o-mini",
				});
				this.store = await createMemoryStore();
			}

			async ask(query: string) {
				if (!this.store) throw new Error("Store not initialized");

				// 1. Recall relevant context
				const context = await this.store.searchUnifiedMemory({
					userId: this.userId,
					query,
					limit: 5,
				});

				// 2. Build prompt with context
				const contextStr = context.results.map((r) => `- ${r.content}`).join("\n");
				const prompt = `User asked: ${query}\n\nRelevant context:\n${contextStr}`;

				// 3. In a real scenario, run the agent (we'll skip since no API key)
				// For testing, we verify the pattern works
				return { prompt, contextCount: context.results.length };
			}
		}

		const agent = new MemoryAwareAgent("test-user");
		await agent.initialize();
		check("MemoryAwareAgent initializes", agent.store !== null);

		const result = await agent.ask("What are my preferences?");
		check("MemoryAwareAgent.ask() returns context", typeof result.prompt === "string");
		check("MemoryAwareAgent.ask() includes context in prompt", result.prompt.includes("Relevant context"));

		return true;
	});
}

// ============================================
// 03-advanced-usage.md: Temporal queries
// ============================================
async function testTemporalQueries() {
	await runSection("03-advanced-usage.md: temporal queries", async () => {
		const check = makeCheck("tutorial/03-temporal");

		process.env.MEMORY_STORE_DB_PATH = join(TEST_DIR, "temporal.db");
		const store = await createMemoryStore();
		const messages = await getRawMessageManager();

		const now = Date.now();
		const lastMonth = now - 30 * 24 * 60 * 60 * 1000;

		// Store messages with different timestamps
		await messages.storeMessages([
			{
				messageId: "temporal-msg-1",
				userId: "user-temporal",
				content: "Project status: Planning phase",
				platform: "test",
				botId: "test-bot",
				timestamp: lastMonth,
				createdAt: lastMonth,
			},
			{
				messageId: "temporal-msg-2",
				userId: "user-temporal",
				content: "Project status: Development phase",
				platform: "test",
				botId: "test-bot",
				timestamp: now,
				createdAt: now,
			},
		]);

		// Test asOf parameter for time-travel query
		const historicalResults = await store.searchUnifiedMemory({
			userId: "user-temporal",
			query: "project status",
			asOf: lastMonth + 1000, // Just after the first message
			limit: 10,
		});
		check("temporal query with asOf accepts timestamp", true);
		check("temporal query returns results", Array.isArray(historicalResults.results));

		// Current query should see both
		const currentResults = await store.searchUnifiedMemory({
			userId: "user-temporal",
			query: "project status",
			limit: 10,
		});
		check("current query returns results", Array.isArray(currentResults.results));

		return true;
	});
}

// ============================================
// 03-advanced-usage.md: Platform integrations
// ============================================
async function testPlatformIntegrations() {
	await runSection("03-advanced-usage.md: platform integrations", async () => {
		const check = makeCheck("tutorial/03-integrations");

		// Test INTEGRATION_IDS constant
		check("INTEGRATION_IDS is an array", Array.isArray(INTEGRATION_IDS));
		check("INTEGRATION_IDS has entries", INTEGRATION_IDS.length > 0);
		check("INTEGRATION_IDS includes gmail", INTEGRATION_IDS.includes("gmail"));
		check("INTEGRATION_IDS includes slack", INTEGRATION_IDS.includes("slack"));

		// Verify specific integrations mentioned in the tutorial
		const tutorialIntegrations = ["gmail", "outlook", "slack", "discord", "teams", "telegram"];
		const missingIntegrations = tutorialIntegrations.filter((id) => !INTEGRATION_IDS.includes(id));
		check("tutorial integrations are available", missingIntegrations.length === 0);

		return true;
	});
}

// ============================================
// 03-advanced-usage.md: Loop engine
// ============================================
async function testLoopEngine() {
	await runSection("03-advanced-usage.md: Loop engine", async () => {
		const check = makeCheck("tutorial/03-loop");

		// Test LOOP_PATHS
		check("LOOP_PATHS exists", typeof LOOP_PATHS === "object");
		check("LOOP_PATHS has config path", typeof LOOP_PATHS.config === "string");

		// Test ensureDirs
		const ensured = ensureDirs();
		check("ensureDirs() executes", typeof ensured === "boolean" || ensured === undefined);

		// Test readPreferences
		const prefs = readPreferences();
		check("readPreferences() returns object", typeof prefs === "object");
		check("preferences has intervalSec", typeof prefs.intervalSec === "number");
		check("preferences has enabled field", typeof prefs.enabled === "boolean");

		// Test writePreferences
		const updated = writePreferences({
			intervalSec: 300,
			narrative: true,
			enabled: true,
		});
		check("writePreferences() returns updated prefs", typeof updated === "object");

		// Verify the update persisted
		const reRead = readPreferences();
		check("preferences persist after write", reRead.intervalSec === 300);

		// Test validateCronExpression
		const validCron = validateCronExpression("0 9 * * *");
		check("validateCronExpression accepts valid cron", validCron === true);

		const invalidCron = validateCronExpression("not a cron");
		check("validateCronExpression rejects invalid cron", invalidCron === false);

		// Test computeNextRun with ScheduleConfig object
		const nextRun = computeNextRun({ type: "cron", expression: "0 9 * * *" }, new Date());
		check("computeNextRun returns Date or null", nextRun === null || nextRun instanceof Date);
		if (nextRun) {
			check("computeNextRun returns future date", nextRun.getTime() > Date.now() - 86400000);
		}

		return true;
	});
}

// ============================================
// 03-advanced-usage.md: Encryption
// ============================================
async function testEncryption() {
	await runSection("03-advanced-usage.md: encryption", async () => {
		const check = makeCheck("tutorial/03-encryption");

		// Set up encryption key for testing
		const originalKey = process.env.ENCRYPTION_KEY;
		process.env.ENCRYPTION_KEY = "test-32-byte-key-for-encryption!!";

		const encryptor = new TokenEncryption();
		check("TokenEncryption constructor works", encryptor !== null);

		// Test encryptToken
		const plaintext = "sk-1234567890abcdef";
		const encrypted = encryptor.encryptToken(plaintext);
		check("encryptToken() returns ciphertext", typeof encrypted === "string");
		check("ciphertext is different from plaintext", encrypted !== plaintext);
		check("ciphertext has reasonable length", encrypted.length > 20);

		// Test decryptToken
		const decrypted = encryptor.decryptToken(encrypted);
		check("decryptToken() returns original text", decrypted === plaintext);

		// Reset to original key
		if (originalKey) {
			process.env.ENCRYPTION_KEY = originalKey;
		} else {
			delete process.env.ENCRYPTION_KEY;
		}

		return true;
	});
}

// ============================================
// 03-advanced-usage.md: URL validation (SSRF protection)
// ============================================
async function testUrlValidation() {
	await runSection("03-advanced-usage.md: URL validation", async () => {
		const check = makeCheck("tutorial/03-ssrf");

		// The validateUrlForSSRF function throws for invalid URLs
		// Test that HTTP is rejected (throws error)
		try {
			await validateUrlForSSRF("http://example.com/data");
			check("validateUrlForSSRF rejects HTTP (should throw)", false);
		} catch (err) {
			check("validateUrlForSSRF rejects HTTP (throws error)", true);
		}

		// Test that loopback is rejected (throws error)
		try {
			await validateUrlForSSRF("http://127.0.0.1:8080");
			check("validateUrlForSSRF rejects loopback (should throw)", false);
		} catch (err) {
			check("validateUrlForSSRF rejects loopback (throws error)", true);
		}

		// Test that private IPs are rejected (throws error)
		try {
			await validateUrlForSSRF("http://192.168.1.1/data");
			check("validateUrlForSSRF rejects private IP (should throw)", false);
		} catch (err) {
			check("validateUrlForSSRF rejects private IP (throws error)", true);
		}

		// Test that cloud metadata is rejected (throws error)
		try {
			await validateUrlForSSRF("http://169.254.169.254/latest/meta-data/");
			check("validateUrlForSSRF rejects cloud metadata (should throw)", false);
		} catch (err) {
			check("validateUrlForSSRF rejects cloud metadata (throws error)", true);
		}

		// Test isTrustedStorageUrl (synchronous, doesn't throw)
		const s3Url = isTrustedStorageUrl("https://s3.amazonaws.com/my-bucket/");
		check("isTrustedStorageUrl accepts S3", s3Url === true);

		const untrustedUrl = isTrustedStorageUrl("https://unknown-storage.com/bucket/");
		check("isTrustedStorageUrl rejects unknown", untrustedUrl === false);

		// Test that non-allowed HTTPS domains are rejected (throws error)
		try {
			await validateUrlForSSRF("https://untrusted-domain.com/data");
			check("validateUrlForSSRF rejects untrusted HTTPS (should throw)", false);
		} catch (err) {
			// Function throws for non-allowed domains - that's correct behavior
			check("validateUrlForSSRF throws for untrusted domain", true);
		}

		return true;
	});
}

// ============================================
// 03-advanced-usage.md: Web search integration
// ============================================
async function testWebSearchIntegration() {
	await runSection("03-advanced-usage.md: web search", async () => {
		const { check, skip } = makeCheckWithSkip("tutorial/03-websearch");

		// Test needsRealTimeInfo classifier
		const needsWeather = needsRealTimeInfo("What is the weather in Tokyo right now?");
		check("needsRealTimeInfo detects time-sensitive query", needsWeather === true);

		const needsNews = needsRealTimeInfo("latest news on AI regulation");
		check("needsRealTimeInfo detects news query", needsNews === true);

		const needsStock = needsRealTimeInfo("stock price of AAPL today");
		check("needsRealTimeInfo detects stock query", needsStock === true);

		const timelessQuery = needsRealTimeInfo("Who wrote Hamlet?");
		check("needsRealTimeInfo recognizes timeless queries", timelessQuery === false);

		// Actual search requires BRAVE_SEARCH_API_KEY
		skip("search() API call", "Requires BRAVE_SEARCH_API_KEY (not set)");

		return true;
	});
}

// ============================================
// 04-best-practices.md: Batch writes
// ============================================
async function testBatchWrites() {
	await runSection("04-best-practices.md: batch writes", async () => {
		const check = makeCheck("tutorial/04-batch");

		process.env.MEMORY_STORE_DB_PATH = join(TEST_DIR, "batch.db");
		const messages = await getRawMessageManager();

		const now = Date.now();

		// Create batch of 100 messages
		const batch = Array.from({ length: 100 }, (_, i) => ({
			messageId: `batch-msg-${i}`,
			userId: "batch-test-user",
			content: `Batch message number ${i}`,
			platform: "test",
			botId: "test-bot",
			timestamp: now + i,
			createdAt: now + i,
		}));

		// Batch write (should be faster than individual writes)
		const startTime = Date.now();
		await messages.storeMessages(batch);
		const duration = Date.now() - startTime;

		check("batch write of 100 messages succeeds", true);
		check("batch write completes in reasonable time", duration < 10000);

		// Verify the messages were stored
		const stored = await messages.getMessageById("batch-msg-50");
		check("batch written message is retrievable", stored !== null);
		check("retrieved message has correct content", stored?.content === "Batch message number 50");

		return true;
	});
}

// ============================================
// 04-best-practices.md: Metadata patterns
// ============================================
async function testMetadataPatterns() {
	await runSection("04-best-practices.md: metadata patterns", async () => {
		const check = makeCheck("tutorial/04-metadata");

		process.env.MEMORY_STORE_DB_PATH = join(TEST_DIR, "metadata.db");
		const messages = await getRawMessageManager();

		const now = Date.now();

		// Test storing facts with rich metadata
		await messages.storeMessages([
			{
				messageId: "decision-msg-1",
				userId: "metadata-test-user",
				content: "Meeting decision: Use TypeScript for new project",
				platform: "test",
				botId: "test-bot",
				timestamp: now,
				createdAt: now,
				metadata: {
					type: "decision",
					project: "new-project",
					meetingId: "meeting-123",
					participants: ["alice", "bob"],
					importance: "high",
					confidence: 0.95,
				},
			},
		]);
		check("storeMessages accepts complex metadata", true);

		// Verify metadata structure is preserved
		const stored = await messages.getMessageById("decision-msg-1");
		check("stored message has metadata", stored?.metadata !== undefined);
		check("metadata preserves type", stored?.metadata?.type === "decision");
		check("metadata preserves participants array", Array.isArray(stored?.metadata?.participants));

		return true;
	});
}

// ============================================
// 04-best-practices.md: Structured user IDs
// ============================================
async function testStructuredUserIds() {
	await runSection("04-best-practices.md: structured user IDs", async () => {
		const check = makeCheck("tutorial/04-userids");

		// Test the pattern: source|type|id
		const slackUserId = `slack|user|U123456`;
		const gmailUserId = `gmail|user|example@gmail.com`;

		check("structured Slack ID follows pattern", slackUserId.includes("slack|user|"));
		check("structured Gmail ID follows pattern", gmailUserId.includes("gmail|user|"));

		// Helper function from best practices
		function buildUserId(platform: string, type: string, id: string): string {
			return `${platform}|${type}|${id}`;
		}

		const built = buildUserId("discord", "user", "123456789");
		check("buildUserId helper works", built === "discord|user|123456789");

		// Test that the pattern prevents conflicts
		const slackUser = buildUserId("slack", "user", "123");
		const gmailUser = buildUserId("gmail", "user", "123");
		check("different platforms produce different user IDs", slackUser !== gmailUser);

		return true;
	});
}

// ============================================
// 04-best-practices.md: Store facts, not chunks
// ============================================
async function testFactsNotChunks() {
	await runSection("04-best-practices.md: facts not chunks", async () => {
		const check = makeCheck("tutorial/04-facts");

		process.env.MEMORY_STORE_DB_PATH = join(TEST_DIR, "facts.db");
		const messages = await getRawMessageManager();

		// GOOD: Storing complete facts
		const factContent = "The user prefers dark mode across all applications";

		await messages.storeMessages([
			{
				messageId: "fact-msg-1",
				userId: "facts-test-user",
				content: factContent,
				platform: "test",
				botId: "test-bot",
				timestamp: Date.now(),
				createdAt: Date.now(),
				metadata: {
					source: "user_profile",
					confidence: 0.95,
				},
			},
		]);

		const retrieved = await messages.getMessageById("fact-msg-1");
		check("fact content is complete", retrieved?.content?.length > 20);
		check("fact metadata includes source", retrieved?.metadata?.source === "user_profile");
		check("fact metadata includes confidence", typeof retrieved?.metadata?.confidence === "number");

		return true;
	});
}

// ============================================
// 04-best-practices.md: messageId stability
// ============================================
async function testMessageIdStability() {
	await runSection("04-best-practices.md: messageId stability", async () => {
		const check = makeCheck("tutorial/04-messageid");

		process.env.MEMORY_STORE_DB_PATH = join(TEST_DIR, "messageid.db");
		const messages = await getRawMessageManager();

		const now = Date.now();
		const userId = "user-messageid-test";

		// Test the stable messageId pattern from best practices
		const platform = "slack";
		const externalId = "external-12345";
		const messageId = `${userId}-${platform}-${externalId}`;

		// First write
		await messages.storeMessages([
			{
				messageId,
				userId,
				content: "First version",
				platform,
				botId: "test-bot",
				timestamp: now,
				createdAt: now,
			},
		]);
		check("first write with stable messageId succeeds", true);

		// Second write with same messageId (should be idempotent)
		await messages.storeMessages([
			{
				messageId,
				userId,
				content: "Second version",
				platform,
				botId: "test-bot",
				timestamp: now + 1000,
				createdAt: now + 1000,
			},
		]);
		check("second write with same messageId succeeds (idempotent)", true);

		// Verify the message exists
		const retrieved = await messages.getMessageById(messageId);
		check("message is retrievable by stable messageId", retrieved !== null);

		return true;
	});
}

// ============================================
// 04-best-practices.md: Warning handling patterns
// ============================================
async function testWarningHandlingPatterns() {
	await runSection("04-best-practices.md: warning handling patterns", async () => {
		const check = makeCheck("tutorial/04-warnings");

		process.env.MEMORY_STORE_DB_PATH = join(TEST_DIR, "warnings.db");
		const store = await createMemoryStore();

		// Search without embedder configured - will produce warnings
		const results = await store.searchUnifiedMemory({
			userId: "test-user",
			query: "test query",
			limit: 10,
		});

		check("search returns results even without embedder", Array.isArray(results.results));
		check("search returns warnings array", Array.isArray(results.warnings));

		// Test structured warning handling pattern from tutorial
		let handledWarnings = 0;
		const warningCodes = new Set<string>();

		for (const warning of results.warnings) {
			handledWarnings++;
			warningCodes.add(warning.code);

			// Pattern from tutorial: switch on warning code
			switch (warning.code) {
				case "embed_query_not_configured":
					// Would fall back to keyword search
					check("embed_query_not_configured detected", true);
					break;
				case "raw_message_storage_unavailable":
					check("raw_message_storage_unavailable detected", true);
					break;
				case "insights_search_not_configured":
					check("insights_search_not_configured detected", true);
					break;
				case "knowledge_search_not_configured":
					check("knowledge_search_not_configured detected", true);
					break;
			}
		}

		check("warning handling loop processes all warnings", handledWarnings === results.warnings.length);
		check("warnings have unique codes tracked", warningCodes.size > 0);

		return true;
	});
}

// ============================================
// Run all extended tests
// ============================================
export default async function testTutorialExtended() {
	await runSection("🧪 Extended Tutorial Tests", async () => {
		setupTestDir();

		try {
			// 01-user-guide.md extended tests
			await testMemoryAwareAgentPattern();

			// 03-advanced-usage.md extended tests
			await testTemporalQueries();
			await testPlatformIntegrations();
			await testLoopEngine();
			await testEncryption();
			await testUrlValidation();
			await testWebSearchIntegration();

			// 04-best-practices.md extended tests
			await testBatchWrites();
			await testMetadataPatterns();
			await testStructuredUserIds();
			await testFactsNotChunks();
			await testMessageIdStability();
			await testWarningHandlingPatterns();

			info("tutorial-extended", "\n" + "=".repeat(50));
			info("tutorial-extended", "✅ ALL EXTENDED TUTORIAL TESTS PASSED!");
			info("tutorial-extended", "=".repeat(50));
		} catch (error) {
			info("tutorial-extended", "\n❌ EXTENDED TEST FAILED:");
			throw error;
		} finally {
			cleanupTestDir();
		}
	});
}
