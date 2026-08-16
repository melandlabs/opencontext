import { getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
	const manager = await getRawMessageManager();

	// First store a message to forget
	const now = Date.now();
	const messageId = `msg-to-forget-${now}`;
	await manager.storeMessages([
		{
			messageId,
			userId: "user-123",
			content: "Temporary fact to archive",
			platform: "tutorial",
			botId: "my-agent",
			timestamp: now,
			createdAt: now,
		},
	]);
	console.log("Stored message to archive:", messageId);

	// Archive marks the fact with `archived_at = now`.
	// The row stays in the database, but search excludes it by default.
	const changed = await manager.archiveMessages([messageId], Date.now(), "user-123");

	console.log(`Archived ${changed} fact(s)`);
}

main().catch((error) => {
	console.error("Forget failed:", error);
	process.exit(1);
});
