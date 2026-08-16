import { createMemoryStore } from "@melandlabs/opencontext";
import { LocalTransformersEmbeddingProvider } from "@melandlabs/opencontext";

async function main() {
	const embedder = new LocalTransformersEmbeddingProvider();

	const store = await createMemoryStore({
		db: {
			type: "sqlite-vec",
			path: "./tutorials-full-setup.db",
		},
		unified: {
			embedQuery: async ({ query }) => {
				return await embedder.embedQuery(query);
			},
		},
	});

	const results = await store.searchUnifiedMemory({
		userId: "user-123",
		query: "What are my preferences?",
		limit: 5,
	});

	console.log(`Found ${results.count} result(s)`);
	console.log("Warnings:", results.warnings.length);
	await store.raw.close();
}

main().catch(console.error);
