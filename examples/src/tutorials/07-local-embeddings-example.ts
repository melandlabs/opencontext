import {
	LocalTransformersEmbeddingProvider,
	createMemoryStore,
	getRawMessageManager,
} from "@melandlabs/opencontext";

async function main() {
	const embeddingProvider = new LocalTransformersEmbeddingProvider({
		modelName: "Xenova/all-MiniLM-L6-v2",
	});

	const store = await createMemoryStore({
		dbPath: "./tutorials-embeddings.db",
		unified: {
			embedQuery: async ({ query }) => {
				return await embeddingProvider.embedQuery(query);
			},
		},
	});

	const messages = await getRawMessageManager();
	const now = Date.now();

	// Store with pre-computed embedding
	const embedding = await embeddingProvider.embedQuery("User prefers dark mode");

	await messages.storeMessages([
		{
			messageId: `msg-${now}`,
			userId: "user-42",
			content: "User prefers dark mode in all applications",
			platform: "tutorial",
			botId: "tutorial-bot",
			timestamp: now,
			createdAt: now,
			embedding,
			embeddingModel: "Xenova/all-MiniLM-L6-v2",
		},
	]);

	// Semantic search
	const results = await store.search({
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

	await store.raw.close();
}

main().catch(console.error);
