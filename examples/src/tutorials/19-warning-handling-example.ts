import { createMemoryStore } from "@melandlabs/opencontext";
import { runIfMain } from "../_helpers.ts";

async function main() {
	const store = await createMemoryStore();

	const results = await store.search({
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

export default main;
runIfMain("warning-handling", main, import.meta.url);
