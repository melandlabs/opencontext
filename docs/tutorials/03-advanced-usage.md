# Advanced Usage - Production Patterns

This guide covers advanced patterns for running OpenContext in production: multi-source search, temporal queries, platform integrations, and the Loop engine.

## Multi-Source Unified Search

OpenContext can search across multiple data sources simultaneously:

```typescript
import { createMemoryStore } from "@melandlabs/opencontext";

const store = await createMemoryStore({
  db: { type: "sqlite-vec", path: "./memory.db" },
  unified: {
    // Required for semantic search
    embedQuery: async ({ query }) => {
      return await myEmbedder.embed(query);
    },

    // Optional: Search raw messages (what users said)
    searchRawMessagesAnn: async ({ userId, queryEmbedding, limit, threshold }) => {
      return await postgresManager.searchAnn({
        userId,
        embedding: queryEmbedding,
        limit,
        threshold: threshold ?? 0.7,
      });
    },

    // Optional: Search insights (extracted facts)
    searchInsights: async ({ userId, query, limit, threshold }) => {
      return await insightIndex.search({
        userId,
        query,
        limit,
        threshold: threshold ?? 0.7,
      });
    },

    // Optional: Search knowledge base (uploaded docs)
    searchKnowledge: async ({ userId, query, options }) => {
      return await ragIndex.search({
        userId,
        query,
        limit: options.limit,
        threshold: options.threshold,
      });
    },
  },
});

// Search across all configured sources
const results = await store.searchUnifiedMemory({
  userId: "user-123",
  query: "What did we decide about the architecture?",
  sources: ["memory", "insights", "knowledge"],
  limit: 10,
  threshold: 0.7,
  botIds: ["architect-bot"],  // Optional: filter by bot
  documentIds: ["doc-456"],   // Optional: filter by document
});

console.log(`Results from ${results.sources.length} sources`);
for (const hit of results.results) {
  console.log(`[${hit.source}] ${hit.content} (${hit.score})`);
}
```

## Temporal (Time-Travel) Queries

Every fact has `valid_from` and `valid_until`, enabling queries as of a specific time:

```typescript
// What did we believe about the project last month?
const lastMonth = Date.now() - 30 * 24 * 60 * 60 * 1000;

const results = await store.searchUnifiedMemory({
  userId: "user-123",
  query: "project status and timeline",
  asOf: lastMonth,  // Query as of this timestamp
  limit: 10,
});

// The results only include facts that were true at that time
```

**Use cases:**
- Audit: "What was the strategy on April 1st?"
- Debugging: "Why did we make that decision last week?"
- Compliance: "What information did we have then?"

## Working with the Temporal Graph

For more advanced temporal queries, access the graph directly:

```typescript
import { getMemoryGraph } from "@melandlabs/opencontext";

const graph = await getMemoryGraph();

// Find facts that supersede other facts
const superseded = await graph.findNodes({
  edgeType: "supersedes",
  userId: "user-123",
});

// Find contradictions
const contradictions = await graph.findNodes({
  edgeType: "contradicts",
  userId: "user-123",
});

// Get full history of a fact
const history = await graph.getHistory("node-123");
/*
[
  { nodeId: "node-123", validFrom: "2024-01-01", validUntil: "2024-02-01", content: "Version 1" },
  { nodeId: "node-124", validFrom: "2024-02-01", validUntil: null, content: "Version 2", supersedes: "node-123" }
]
*/
```

## Platform Integrations

OpenContext supports 27+ platforms with a unified `IntegrationRecord` shape:

### Available Platforms

```typescript
import { INTEGRATION_IDS } from "@melandlabs/opencontext";

console.log(INTEGRATION_IDS);
// gmail, outlook, slack, discord, teams, telegram, whatsapp,
// linkedin, instagram, x, facebook_messenger, hubspot, notion,
// asana, jira, linear, imessage, feishu, dingtalk, qqbot, weixin,
// google_calendar, google_meet, google_drive, google_docs, rss
```

### Using an Integration

```typescript
import { getIntegrationManager } from "@melandlabs/opencontext";

const integrations = await getIntegrationManager();

// Check if an integration is connected
const isConnected = await integrations.isConnected("gmail", "user-123");

// Fetch messages from Gmail
const messages = await integrations.fetchMessages({
  platform: "gmail",
  userId: "user-123",
  limit: 50,
  since: Date.now() - 7 * 24 * 60 * 60 * 1000,  // Last 7 days
});

// Each message is a normalized IntegrationRecord
for (const msg of messages) {
  await rememberFact("user-123", msg.content);
}
```

### Sending Messages (Write)

```typescript
// Send a message through Slack
await integrations.sendMessage({
  platform: "slack",
  userId: "user-123",
  channel: "general",
  content: "Here's your daily summary...",
});
```

## The Loop Engine

The Loop engine is a deterministic scheduler that wakes your agent on a schedule:

```typescript
import {
  LOOP_PATHS,
  ensureDirs,
  readPreferences,
  writePreferences,
} from "@melandlabs/opencontext";

// Ensure Loop directories exist
ensureDirs();

// Read current preferences (or get defaults)
const prefs = readPreferences();
console.log("Current interval:", prefs.intervalSec, "seconds");

// Update preferences
const updated = writePreferences({
  intervalSec: 300,  // Run every 5 minutes
  narrative: true,   // Enable narrative mode
  enabled: true,    // Enable Loop
});

console.log("Updated preferences:", updated);
```

### Loop Configuration File

Loop stores its config in `~/.opencontext/loop/config.json`:

```json
{
  "enabled": true,
  "intervalSec": 300,
  "narrative": false,
  "lastRun": 1704067200000,
  "schedule": []
}
```

### Scheduled Tasks

```typescript
import { validateCronExpression, computeNextRun } from "@melandlabs/opencontext";

// Validate a cron expression
const isValid = validateCronExpression("0 9 * * *");  // Daily at 9 AM

// Compute next run time
const nextRun = computeNextRun("0 9 * * *", Date.now());
console.log("Next run:", new Date(nextRun).toISOString());
```

## Encryption and Security

### Encrypting Secrets

```typescript
import { TokenEncryption } from "@melandlabs/opencontext";

// Create an encryptor with your key
const key = process.env.ENCRYPTION_KEY || "your-32-byte-key-here!!!!";
const encryptor = new TokenEncryption(key);

// Encrypt a token
const encrypted = await encryptor.encrypt("sk-1234567890abcdef");

// Store it safely
await database.save({ userId: "user-123", encryptedToken: encrypted });

// Decrypt it later
const decrypted = await encryptor.decrypt(encrypted);
console.log("Decrypted:", decrypted);
```

### URL Validation (SSRF Protection)

```typescript
import { validateUrlForSSRF, isTrustedStorageUrl } from "@melandlabs/opencontext";

// Check if a URL is safe to call
const safe = await validateUrlForSSRF("https://api.example.com/data");
// Rejects: plain HTTP, loopback, private IPs, cloud metadata

// Check if a storage URL is trusted
const trusted = isTrustedStorageUrl("https://s3.amazonaws.com/my-bucket/");
```

## Voice Capabilities

### Text-to-Speech (Kokoro)

```typescript
import { LocalKokoroTTS } from "@melandlabs/opencontext";

const tts = new LocalKokoroTTS();

const audioBuffer = await tts.synthesize("Hello, world!");
// Returns a Buffer containing WAV audio
```

### Speech-to-Text (Whisper)

```typescript
import { LocalWhisperSTT } from "@melandlabs/opencontext";

const stt = new LocalWhisperSTT();

const transcript = await stt.transcribe(audioBuffer);
console.log("Transcript:", transcript);
```

## Web Search Integration

```typescript
import { needsRealTimeInfo, search } from "@melandlabs/opencontext";

// Classify if a query needs real-time info
const needsLive = needsRealTimeInfo("What's the weather today?");
console.log("Needs live data:", needsLive);  // true

// Perform web search
if (needsLive && process.env.BRAVE_SEARCH_API_KEY) {
  const results = await search("OpenContext AI memory runtime", {
    count: 5,
    countryCode: "US",
  });

  for (const result of results.web.results) {
    console.log(`- ${result.title}: ${result.url}`);
    console.log(`  ${result.description}`);
  }
}
```

## Audit Logging

OpenContext writes structured audit logs to `~/.opencontext/logs/audit.jsonl`:

```jsonl
{"timestamp":1704067200000,"level":"info","event":"memory_write","userId":"user-123","messageId":"msg-456"}
{"timestamp":1704067260000,"level":"info","event":"memory_recall","userId":"user-123","query":"project status","count":5}
```

Parse the audit log:

```bash
# View recent audit entries
tail -f ~/.opencontext/logs/audit.jsonl | jq

# Count memory writes per user
cat ~/.opencontext/logs/audit.jsonl | jq -r 'select(.event=="memory_write") | .userId' | sort | uniq -c
```

## Performance Optimization

### Batch Operations

```typescript
// Batching is faster than individual calls
const messages = await getRawMessageManager();

// Batch store 1000 messages
const batch = Array.from({ length: 1000 }, (_, i) => ({
  messageId: `msg-${i}`,
  userId: "user-123",
  content: `Message ${i}`,
  platform: "test",
  botId: "test",
  timestamp: Date.now(),
  createdAt: Date.now(),
}));

await messages.storeMessages(batch);
```

### Embedding Caching

```typescript
import { LRUCache } from "lru-cache";

const embeddingCache = new LRUCache<string, number[]>({
  max: 1000,  // Cache 1000 embeddings
});

async function getCachedEmbedding(text: string) {
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const embedding = await embedder.embed(text);
  embeddingCache.set(text, embedding);
  return embedding;
}
```

### Connection Pooling (Postgres)

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// Connection pool for Postgres
const client = postgres(process.env.DATABASE_URL!, {
  max: 10,  // Max connections
  idle_timeout: 20,
  connect_timeout: 10,
});

const db = drizzle(client, { logger: true });
```

## Monitoring

### Health Checks

```bash
# Check all subsystems
opencontext doctor

# Check specific subsystems
opencontext doctor --section memory-store
opencontext doctor --section embedding
opencontext doctor --section integrations

# JSON output for monitoring
opencontext doctor --json | jq '.ok'
```

### Metrics

```typescript
// Track your own metrics
const metrics = {
  memoryWrites: 0,
  memoryRecalls: 0,
  embeddings: 0,
};

async function trackedRemember(userId: string, content: string) {
  metrics.memoryWrites++;
  await rememberFact(userId, content);
}

async function trackedRecall(userId: string, query: string) {
  metrics.memoryRecalls++;
  return await recallFacts(userId, query);
}

// Log metrics periodically
setInterval(() => {
  console.log("Metrics:", metrics);
}, 60000);
```

## Next Steps

- 📖 [Getting Started](./00-getting-started.md) - Quick start
- 👤 [User Guide](./01-user-guide.md) - Core concepts
- 🔧 [Developer Guide](./02-developer-guide.md) - Integration
- 📚 [Best Practices](./04-best-practices.md) - Optimization

---

**Sources:**
- [ClickHelp - Best Practices for Creating Developer Documentation](https://clickhelp.com/clickhelp-technical-writing-blog/best-practices-for-creating-developer-documentation/)
- [UpGrad - Open Source Projects for Beginners](https://www.upgrad.com/blog/open-source-projects-for-beginners/)
