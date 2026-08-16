import { getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  const messages = await getRawMessageManager();

  // Batch store 100 messages
  const batch = Array.from({ length: 100 }, (_, i) => ({
    messageId: `batch-msg-${i}-${Date.now()}`,
    userId: "user-123",
    content: `Message ${i}`,
    platform: "test",
    botId: "test",
    timestamp: Date.now(),
    createdAt: Date.now(),
  }));

  await messages.storeMessages(batch);
  console.log(`Stored ${batch.length} messages in one batch`);
}

main().catch(console.error);
