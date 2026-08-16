import { getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  const messages = await getRawMessageManager();
  const now = Date.now();

  await messages.storeMessages([
    {
      // Required fields
      messageId: `msg-${now}`,    // Makes re-ingest idempotent
      userId: "user-123",
      content: "User prefers dark mode",
      platform: "slack",
      botId: "my-agent",

      // Timestamps
      timestamp: now,      // When the message was sent
      createdAt: now,      // When we ingested it

      // Optional metadata
      metadata: {
        channel: "general",
        threadId: "thread-456",
      },
    },
  ]);

  console.log("✅ Fact stored");
}

main().catch((error) => {
  console.error("Failed to store fact:", error);
  process.exit(1);
});
