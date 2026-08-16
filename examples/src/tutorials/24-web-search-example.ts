import { needsRealTimeInfo, search } from "@melandlabs/opencontext";

async function main() {
	// Classify if a query needs real-time info
	const needsLive = needsRealTimeInfo("What's the weather today?");
	console.log("Needs live data:", needsLive); // true

	// Perform web search (Brave Search API)
	if (needsLive && process.env.BRAVE_SEARCH_API_KEY) {
		const results = await search("OpenContext AI memory runtime", "web", 5);

		for (const result of results) {
			console.log(`- ${result.title}: ${result.url}`);
			console.log(`  ${result.description}`);
		}
	} else {
		console.log("Skipping live search: no BRAVE_SEARCH_API_KEY set");
	}
}

main().catch((error) => {
	console.error("Web search failed:", error);
	process.exit(1);
});
