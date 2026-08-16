const MEMORY_URL = process.env.MEMORY_URL || "http://127.0.0.1:7421";

async function recallFacts(userId: string, query: string) {
	const response = await fetch(`${MEMORY_URL}/v1/search`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ userId, query, limit: 10 }),
	});

	return response.json();
}

async function rememberFact(userId: string, content: string) {
	const now = Date.now();
	const response = await fetch(`${MEMORY_URL}/v1/raw-messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			userId,
			embedOnInsert: true,
			messages: [
				{
					messageId: `msg-${now}`,
					role: "user",
					content,
					platform: "my-app",
					botId: "default",
					timestamp: now,
					createdAt: now,
				},
			],
		}),
	});

	return response.json();
}

async function main() {
	const userId = "user-http-client";
	await rememberFact(userId, "User prefers dark mode in all applications");
	const results = await recallFacts(userId, "What does the user prefer?");
	console.log("Found", results.count, "results");
	for (const hit of results.results) {
		console.log(`- ${hit.content}`);
	}
}

main().catch(console.error);
