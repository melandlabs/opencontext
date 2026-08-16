import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
	const store = await createMemoryStore();
	const messages = await getRawMessageManager();

	// Store a fact now
	const now = Date.now();
	const messageId = `msg-timetravel-${now}`;
	await messages.storeMessages([
		{
			messageId,
			userId: "user-123",
			content: "Project deadline is December 1st",
			platform: "tutorial",
			botId: "my-agent",
			timestamp: now,
			createdAt: now,
		},
	]);
	console.log("Stored fact now:", messageId);

	// Ask: "What did we believe on April 1st?"
	const factsAsOfApril = await store.searchUnifiedMemory({
		userId: "user-123",
		query: "project status",
		asOf: new Date("2024-04-01").getTime(),
	});

	console.log(`Found ${factsAsOfApril.count} fact(s) as of April 1st`);
	for (const hit of factsAsOfApril.results) {
		console.log(`- ${hit.content}`);
	}
}

main().catch((error) => {
	console.error("Time-travel query failed:", error);
	process.exit(1);
});
