import { getRawMessageManager } from "@melandlabs/opencontext";
import { runIfMain } from "../_helpers.ts";

async function main() {
	const messages = await getRawMessageManager();
	const now = Date.now();

	await messages.storeMessages([
		{
			// Required fields
			messageId: `msg-${now}`, // Makes re-ingest idempotent
			userId: "user-123",
			content: "User prefers dark mode",
			platform: "slack",
			botId: "my-agent",

			// Timestamps
			timestamp: now, // When the message was sent
			createdAt: now, // When we ingested it

			// Optional metadata
			metadata: {
				channel: "general",
				threadId: "thread-456",
			},
		},
	]);

	console.log("✅ Fact stored");
}

export default main;
runIfMain("remember-example", main, import.meta.url);
