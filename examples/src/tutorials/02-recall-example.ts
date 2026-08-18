import { createMemoryStore } from "@melandlabs/opencontext";

async function main() {
	const store = await createMemoryStore();

	const results = await store.search({
		userId: "user-123",
		query: "What are the user's preferences?",
		limit: 10,
		// Optional filters
		sources: ["memory", "insights", "knowledge"],
		threshold: 0.7,
		botIds: ["my-agent"],
	});

	console.log(`Found ${results.count} results`);
	console.log(`Sources consulted: ${results.sources.join(", ")}`);

	for (const warning of results.warnings) {
		console.warn(`[${warning.source}] ${warning.message}`);
	}

	for (const hit of results.results) {
		console.log(`- ${hit.content} (similarity: ${hit.similarity})`);
	}
}

main().catch((error) => {
	console.error("Search failed:", error);
	process.exit(1);
});
