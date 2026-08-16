import { getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  const manager = await getRawMessageManager();
  const now = Date.now();

  // 1. Store an original fact
  const originalMessageId = `msg-original-${now}`;
  await manager.storeMessages([
    {
      messageId: originalMessageId,
      userId: "user-123",
      content: "User prefers dark mode",
      platform: "slack",
      botId: "my-agent",
      timestamp: now,
      createdAt: now,
    },
  ]);
  console.log("Stored original fact:", originalMessageId);

  // 2. Store the corrected fact as a new message.
  const newMessageId = `msg-corrected-${now}`;
  await manager.storeMessages([
    {
      messageId: newMessageId,
      userId: "user-123",
      content: "User now prefers light mode",
      platform: "slack",
      botId: "my-agent",
      timestamp: now,
      createdAt: now,
    },
  ]);
  console.log("Stored corrected fact:", newMessageId);

  // 3. Deprecate the old fact so search hides it by default.
  const changed = await manager.deprecateMessages([originalMessageId], {
    userId: "user-123",
    reason: "User updated preference",
    supersededBySummaryId: newMessageId,
  });

  console.log(`Deprecated ${changed} old fact(s)`);
}

main().catch((error) => {
  console.error("Improve failed:", error);
  process.exit(1);
});
