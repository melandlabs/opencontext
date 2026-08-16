import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  // Create the memory store (uses SQLite by default)
  const store = await createMemoryStore();
  const messages = await getRawMessageManager();

  const now = Date.now();
  // Use a unique message ID to avoid conflicts when running multiple times
  const messageId = `msg-${now}`;

  // Store a fact about the user
  await messages.storeMessages([
    {
      messageId,
      userId: "user-42",
      content: "User prefers dark mode in all applications",
      platform: "tutorial",
      botId: "tutorial-bot",
      timestamp: now,
      createdAt: now,
    },
  ]);

  console.log("✅ Memory stored!");

  // Search for what we just stored
  const results = await store.searchUnifiedMemory({
    userId: "user-42",
    query: "What does the user prefer?",
    limit: 5,
  });

  console.log("🔍 Search results:", results);
  console.log(`Found ${results.count} results`);
  console.log(`Warnings: ${results.warnings.length}`);
}

main().catch(console.error);
