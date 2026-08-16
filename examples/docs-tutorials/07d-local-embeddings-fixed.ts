import { createMemoryStore, LocalTransformersEmbeddingProvider } from "@melandlabs/opencontext";

async function main() {
	const embeddingProvider = new LocalTransformersEmbeddingProvider({
		modelName: "Xenova/all-MiniLM-L6-v2",
	});

	const store = await createMemoryStore({
		db: { type: "sqlite-vec", path: "./tutorials-embeddings-fixed.db" },
		unified: {
			embedQuery: async ({ query }) => {
				return await embeddingProvider.embedQuery(query);
			},
		},
	});

	// store.raw has getBackend / isAvailable / getManager / close.
	// Use getManager() to reach storeMessages.
	const messages = await store.raw.getManager();
	const now = Date.now();

	const content = "User prefers dark mode in all applications";
	const embedding = await embeddingProvider.embedQuery(content);

	await messages.storeMessages([
		{
			messageId: `msg-${now}`,
			userId: "user-42",
			content,
			platform: "tutorial",
			botId: "tutorial-bot",
			timestamp: now,
			createdAt: now,
			embedding,
			embeddingModel: "Xenova/all-MiniLM-L6-v2",
		},
	]);
	console.log("Stored message via store.raw.getManager().storeMessages");

	const results = await store.searchUnifiedMemory({
		userId: "user-42",
		query: "What theme does the user like?",
		limit: 5,
		threshold: 0.0,
	});

	console.log("Found", results.count, "results");
	console.log("Warnings:", results.warnings.length);
	for (const hit of results.results) {
		console.log(`- ${hit.content} (${hit.similarity ?? hit.score})`);
	}

	// NOTE: in @melandlabs/opencontext@0.2.4 this SDK path runs without crashing
	// but the sqlite-vec raw-message semantic search currently returns 0 hits.
	// For a working semantic-search demo see 07i-semantic-search-wired.ts.

	await store.raw.close();
}

main().catch(console.error);
