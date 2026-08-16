import { getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
	const messages = await getRawMessageManager();
	const now = Date.now();

	await messages.storeMessages([
		{
			messageId: `msg-metadata-${now}`,
			userId: "user-123",
			content: "Meeting decision: Use TypeScript for new project",
			platform: "slack",
			botId: "my-agent",
			timestamp: now,
			createdAt: now,
			metadata: {
				type: "decision",
				project: "new-project",
				meetingId: "meeting-123",
				participants: ["alice", "bob"],
				importance: "high",
			},
		},
	]);

	console.log("✅ Stored fact with metadata");
}

main().catch(console.error);
