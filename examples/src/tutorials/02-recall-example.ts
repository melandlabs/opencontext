import { createMemoryStore } from "@melandlabs/opencontext";
import { runIfMain } from "../_helpers.ts";

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

export default main;
runIfMain("recall-example", main, import.meta.url);
