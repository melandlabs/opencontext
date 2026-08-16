import { createMemoryStore } from "@melandlabs/opencontext";

async function main() {
	const store = await createMemoryStore();

	const results = await store.searchUnifiedMemory({
		userId: "user-123",
		query: "preferences",
		limit: 10,
	});

	// Handle warnings appropriately
	for (const warning of results.warnings) {
		switch (warning.code) {
			case "embed_query_not_configured":
				console.warn("Search is limited - embeddings not available");
				break;
			case "raw_message_storage_unavailable":
				console.warn("Memory storage unavailable");
				break;
			default:
				console.warn(`[${warning.source}] ${warning.code}: ${warning.message}`);
		}
	}

	console.log(`Found ${results.count} results`);
}

main().catch(console.error);
