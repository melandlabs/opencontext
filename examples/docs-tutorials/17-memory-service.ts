import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

let store: Awaited<ReturnType<typeof createMemoryStore>>;

export async function initMemory() {
  store = await createMemoryStore({
    db: {
      type: "sqlite-vec",
      path: process.env.MEMORY_DB_PATH || "./tutorials-memory-service.db",
    },
  });
}

export async function rememberFact(userId: string, content: string) {
  const messages = await getRawMessageManager();
  const now = Date.now();

  await messages.storeMessages([{
    messageId: `msg-${now}-${userId}`,
    userId,
    content,
    platform: "my-app",
    botId: "default",
    timestamp: now,
    createdAt: now,
  }]);
}

export async function recallFacts(userId: string, query: string, limit = 10) {
  return store.searchUnifiedMemory({ userId, query, limit });
}

async function main() {
  await initMemory();
  const userId = "user-memory-service";
  await rememberFact(userId, "User prefers dark mode");
  const results = await recallFacts(userId, "preferences");
  console.log(`Found ${results.count} results`);
  for (const hit of results.results) {
    console.log(`- ${hit.content}`);
  }
  await store.raw.close();
}

main().catch(console.error);
