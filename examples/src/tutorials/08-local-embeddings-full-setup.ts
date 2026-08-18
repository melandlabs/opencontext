import { LocalTransformersEmbeddingProvider, createMemoryStore } from "@melandlabs/opencontext";

async function main() {
	const embedder = new LocalTransformersEmbeddingProvider({
		modelName: "Xenova/all-MiniLM-L6-v2",
	});

	const store = await createMemoryStore({
		dbPath: "./tutorials-full-setup.db",
		unified: {
			embedQuery: async ({ query }) => {
				return await embedder.embedQuery(query);
			},
		},
	});

	const results = await store.search({
		userId: "user-123",
		query: "What are my preferences?",
		limit: 5,
		threshold: 0.0,
	});

	console.log(`Found ${results.count} result(s)`);
	console.log("Warnings:", results.warnings.length);
	await store.raw.close();
}

main().catch(console.error);
