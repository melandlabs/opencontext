/**
 * Reasoning-backed memory retrieval.
 *
 * This example shows how to enhance `store.search()` with an LLM:
 *
 *   - "rewrite" rephrases the assistant's question into a first-person
 *     memory-check question, which often matches the register of chat logs.
 *   - "iterative" lets a small planner search, note evidence, and search again,
 *     which helps on multi-hop or temporally constrained questions.
 *
 * Set these environment variables before running:
 *
 *   OPENCONTEXT_LLM_API_KEY=your-key
 *   OPENCONTEXT_LLM_BASE_URL=https://api.deepseek.com/v1   # or your provider
 *   OPENCONTEXT_LLM_MODEL=deepseek-chat                    # or your model
 *
 * Run:
 *   cd examples
 *   node --env-file=../.env --experimental-strip-types src/tutorials/10-reasoning-memory-example.ts
 */

import {
	LocalTransformersEmbeddingProvider,
	createMemoryReasoningProviders,
	createMemoryStore,
	getRawMessageManager,
} from "@melandlabs/opencontext";
import { runIfMain } from "../_helpers.ts";

import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
	const apiKey = process.env.OPENCONTEXT_LLM_API_KEY;
	if (!apiKey) {
		console.log("Skipping reasoning demo: OPENCONTEXT_LLM_API_KEY is not set");
		return;
	}

	const embeddingProvider = new LocalTransformersEmbeddingProvider({
		modelName: "Xenova/all-MiniLM-L6-v2",
	});

	const reasoning = createMemoryReasoningProviders({});

	const store = await createMemoryStore({
		dbPath: join(tmpdir(), `tutorials-reasoning-${process.pid}-${Date.now()}.db`),
		unified: {
			embedQuery: async ({ query }) => embeddingProvider.embedQuery(query),
			reasoning: {
				queryRewriter: reasoning.queryRewriter,
				iterativePlanner: reasoning.iterativePlanner,
			},
		},
	});

	const messages = await getRawMessageManager();
	const now = Date.now();

	// Seed a few first-person memories at different points in time.
	const summerEmbedding = await embeddingProvider.embedQuery("hiking mountains outdoors summer");
	const winterEmbedding = await embeddingProvider.embedQuery("skiing snow outdoors winter");
	await messages.storeMessages([
		{
			messageId: `msg-summer-${now}`,
			userId: "user-42",
			content: "I told you I love hiking in the mountains on weekends.",
			platform: "tutorial",
			botId: "tutorial-bot",
			timestamp: Date.parse("2024-06-15T10:00:00Z"),
			createdAt: now,
			embedding: summerEmbedding,
			embeddingModel: "Xenova/all-MiniLM-L6-v2",
		},
		{
			messageId: `msg-winter-${now}`,
			userId: "user-42",
			content: "Last winter I mentioned I really enjoy skiing.",
			platform: "tutorial",
			botId: "tutorial-bot",
			timestamp: Date.parse("2024-01-20T10:00:00Z"),
			createdAt: now,
			embedding: winterEmbedding,
			embeddingModel: "Xenova/all-MiniLM-L6-v2",
		},
	]);

	// Rewrite strategy: one LLM call to rephrase, then semantic search.
	console.log("\n--- rewrite strategy ---");
	const rewriteResults = await store.search({
		userId: "user-42",
		query: "What does the user enjoy doing on weekends?",
		reasoningStrategy: "rewrite",
		limit: 5,
		threshold: 0.0,
	});
	console.log(`count=${rewriteResults.count}`);
	console.log("reasoning:", rewriteResults.reasoning);
	for (const hit of rewriteResults.results) {
		console.log(`- ${hit.content}`);
	}

	// Iterative strategy: planner searches multiple times under LLM control.
	console.log("\n--- iterative strategy ---");
	const iterativeResults = await store.search({
		userId: "user-42",
		query: "What outdoor activities has the user mentioned?",
		reasoningStrategy: "iterative",
		limit: 5,
		threshold: 0.0,
	});
	console.log(`count=${iterativeResults.count}`);
	console.log("reasoning:", iterativeResults.reasoning);
	for (const hit of iterativeResults.results) {
		console.log(`- ${hit.content}`);
	}

	// Date-range filtering: restrict the planner to a calendar window.
	console.log("\n--- iterative strategy with date range ---");
	const dateRangeResults = await store.search({
		userId: "user-42",
		query: "What outdoor activities has the user mentioned?",
		reasoningStrategy: "iterative",
		dateFrom: "2024-05-01",
		dateTo: "2024-08-31",
		limit: 5,
		threshold: 0.0,
	});
	console.log(`count=${dateRangeResults.count}`);
	console.log("reasoning:", dateRangeResults.reasoning);
	for (const hit of dateRangeResults.results) {
		console.log(`- ${hit.content}`);
	}

	await store.raw.close();
}

export default main;
runIfMain("reasoning-memory", main, import.meta.url);
