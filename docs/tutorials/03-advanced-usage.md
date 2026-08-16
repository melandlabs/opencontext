# Advanced Usage - Production Patterns

This guide covers advanced patterns for running OpenContext in production: multi-source search, temporal queries, platform integrations, and the Loop engine.

## Multi-Source Unified Search

OpenContext can search across multiple data sources simultaneously. The default setup searches raw memory with a lexical fallback; to enable semantic search you wire an `embedQuery` function. You can also plug in optional `searchInsights` and `searchKnowledge` providers to search extracted facts and uploaded documents in the same call.

```typescript
// multi-source-search-example.ts
// Run with: npx tsx multi-source-search-example.ts
// Note: semantic search needs @melandlabs/ai-rag installed.
import { createMemoryStore, LocalTransformersEmbeddingProvider } from "@melandlabs/opencontext";

async function main() {
  const embeddingProvider = new LocalTransformersEmbeddingProvider({
    modelName: "Xenova/all-MiniLM-L6-v2",
  });

  const store = await createMemoryStore({
    unified: {
      embedQuery: async ({ query }) => {
        return await embeddingProvider.embedQuery(query);
      },

      // Optional: search extracted insights (provide your own index).
      searchInsights: async ({ userId, query, limit, threshold }) => {
        // Replace with your insights index, e.g. vector DB or graph search.
        console.log("Searching insights for:", { userId, query, limit, threshold });
        return [];
      },

      // Optional: search uploaded documents (provide your own RAG index).
      searchKnowledge: async ({ userId, query, options }) => {
        // Replace with your knowledge-base index.
        console.log("Searching knowledge for:", { userId, query, options });
        return [];
      },
    },
  });

  const results = await store.searchUnifiedMemory({
    userId: "user-123",
    query: "What did we decide about the architecture?",
    sources: ["memory", "insights", "knowledge"],
    limit: 10,
    threshold: 0.7,
    botIds: ["architect-bot"],  // Optional: filter by bot
    documentIds: ["doc-456"],   // Optional: filter by document
  });

  console.log(`Searched ${results.sources.length} source(s)`);
  for (const warning of results.warnings) {
    console.warn(`[${warning.source}] ${warning.code}: ${warning.message}`);
  }
  for (const hit of results.results) {
    console.log(`[${hit.type}] ${hit.content} (${hit.similarity})`);
  }

  await store.raw.close();
}

main().catch((error) => {
  console.error("Multi-source search failed:", error);
  process.exit(1);
});
```

## Temporal (Time-Travel) Queries

Every fact has `valid_from` and `valid_until`, enabling queries as of a specific time. Pass an ISO-8601 string to `asOf`:

```typescript
// temporal-query-example.ts
// Run with: npx tsx temporal-query-example.ts
import { createMemoryStore } from "@melandlabs/opencontext";

async function main() {
  const store = await createMemoryStore();

  // What did we believe about the project last month?
  const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const results = await store.searchUnifiedMemory({
    userId: "user-123",
    query: "project status and timeline",
    asOf: lastMonth,  // Query as of this ISO-8601 timestamp
    limit: 10,
  });

  console.log(`Found ${results.count} fact(s) that were true last month`);
  for (const hit of results.results) {
    console.log(`- ${hit.content}`);
  }

  await store.raw.close();
}

main().catch((error) => {
  console.error("Temporal query failed:", error);
  process.exit(1);
});
```

**Use cases:**
- Audit: "What was the strategy on April 1st?"
- Debugging: "Why did we make that decision last week?"
- Compliance: "What information did we have then?"

## Working with the Temporal Graph

For more advanced temporal queries, inspect the raw-message store directly. Every message records when it was created, archived, or deprecated, so you can reconstruct the history of a fact without a separate graph API:

```typescript
// temporal-graph-example.ts
// Run with: npx tsx temporal-graph-example.ts
import { getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  const manager = await getRawMessageManager();

  // Query active facts for a user.
  const active = await manager.queryMessages({
    userId: "user-123",
    keywords: ["project status"],
    includeArchived: false,
  });

  console.log(`Active facts: ${active.length}`);
  for (const msg of active) {
    console.log(`- ${msg.content}`);
  }

  // Query deprecated / corrected facts to see what changed over time.
  const deprecated = await manager.queryMessages({
    userId: "user-123",
    includeArchived: true,
  });

  console.log("\nDeprecated or archived facts:");
  for (const msg of deprecated) {
    if (msg.deprecatedAt || msg.archivedAt) {
      console.log(
        `- ${msg.content}\n  deprecatedAt: ${msg.deprecatedAt ?? "n/a"}\n  archivedAt: ${msg.archivedAt ?? "n/a"}\n  reason: ${msg.deprecationReason ?? "n/a"}`,
      );
    }
  }
}

main().catch((error) => {
  console.error("Temporal graph query failed:", error);
  process.exit(1);
});
```

## Platform Integrations

OpenContext supports multiple platforms. Integration IDs are exported from the contracts package, and each platform has a dedicated adapter under `@melandlabs/integrations/*`.

### Available Platforms

```typescript
// list-integrations-example.ts
// Run with: npx tsx list-integrations-example.ts
import { INTEGRATION_IDS } from "@melandlabs/opencontext";

console.log("Supported integrations:");
for (const id of INTEGRATION_IDS) {
  console.log(`- ${id}`);
}
```

### Ingesting Platform Messages

There is no single `IntegrationManager` facade. Each platform adapter (e.g. `@melandlabs/integrations/gmail`, `@melandlabs/integrations/slack`) returns messages in its own shape. A typical ingestion loop normalizes those messages into `RawMessage` records and stores them:

```typescript
// ingest-messages-example.ts
// Run with: npx tsx ingest-messages-example.ts
import { getRawMessageManager } from "@melandlabs/opencontext";
import type { RawMessage } from "@melandlabs/opencontext";

interface PlatformMessage {
  id: string;
  userId: string;
  content: string;
  platform: string;
  timestamp: number;
}

async function ingestMessages(messages: PlatformMessage[]) {
  const manager = await getRawMessageManager();

  const rawMessages: RawMessage[] = messages.map((msg) => ({
    messageId: msg.id,
    userId: msg.userId,
    content: msg.content,
    platform: msg.platform,
    botId: "ingest-bot",
    timestamp: msg.timestamp,
    createdAt: Date.now(),
  }));

  const ids = await manager.storeMessages(rawMessages);
  console.log(`Ingested ${ids.length} message(s)`);
}

async function main() {
  // Replace this with a real adapter call, e.g. fetchGmailMessages(userId).
  const exampleMessages: PlatformMessage[] = [
    {
      id: `msg-${Date.now()}`,
      userId: "user-123",
      content: "Meeting moved to 3pm",
      platform: "gmail",
      timestamp: Date.now(),
    },
  ];

  await ingestMessages(exampleMessages);
}

main().catch((error) => {
  console.error("Ingestion failed:", error);
  process.exit(1);
});
```

See the individual `@melandlabs/integrations-*` packages for platform-specific authentication, fetching, and sending APIs.

## The Loop Engine

The Loop engine is a deterministic scheduler that wakes your agent on a schedule. It stores its config in `~/.opencontext/loop/config.json`.

```typescript
// loop-engine-example.ts
// Run with: npx tsx loop-engine-example.ts
import {
  LOOP_PATHS,
  ensureDirs,
  readPreferences,
  writePreferences,
} from "@melandlabs/opencontext";

async function main() {
  // Ensure Loop directories exist
  ensureDirs();

  // Read current preferences (or get defaults)
  const prefs = readPreferences();
  console.log("Current tick interval:", prefs.intervalSec, "seconds");
  console.log("Loop enabled:", prefs.enabled);

  // Update preferences. Only the fields you pass are patched.
  const updated = writePreferences({
    enabled: true,
    intervalSec: 300,          // Tick every 5 minutes
    narrative: true,           // Generate narrative brief/wrap
    briefTime: "09:00",        // Morning brief at 9 AM
    wrapTime: "21:00",         // Evening wrap at 9 PM
  });

  console.log("Updated preferences:", updated);
  console.log("Config file:", LOOP_PATHS.config);
}

main().catch((error) => {
  console.error("Loop engine example failed:", error);
  process.exit(1);
});
```

### Loop Configuration File

After running the example, `~/.opencontext/loop/config.json` looks similar to:

```json
{
  "enabled": true,
  "intervalSec": 300,
  "narrative": true,
  "briefTime": "09:00",
  "wrapTime": "21:00",
  "noReplySkip": true,
  "promotionSkip": true
}
```

### Scheduled Tasks

Use the `@melandlabs/cron` package to validate cron expressions and compute the next run time:

```typescript
// scheduled-tasks-example.ts
// Run with: npx tsx scheduled-tasks-example.ts
import { computeNextRun, validateCronExpression } from "@melandlabs/opencontext";

async function main() {
  // Validate a cron expression
  const isValid = validateCronExpression("0 9 * * *");  // Daily at 9 AM
  console.log("Cron valid:", isValid);

  // Compute next run time. computeNextRun takes a ScheduleConfig object.
  const nextRun = computeNextRun(
    { type: "cron", expression: "0 9 * * *" },
    new Date(),
  );

  if (nextRun) {
    console.log("Next run:", nextRun.toISOString());
  } else {
    console.log("No next run scheduled");
  }
}

main().catch((error) => {
  console.error("Scheduled task example failed:", error);
  process.exit(1);
});
```

## Encryption and Security

These utilities are re-exported from `@melandlabs/opencontext` for convenience.

### Encrypting Secrets

`TokenEncryption` reads the key from the `ENCRYPTION_KEY` environment variable and expects a 32-byte value (or a password from which a 32-byte key is derived).

```typescript
// token-encryption-example.ts
// Run with: ENCRYPTION_KEY=your-32-byte-key-here!!!! npx tsx token-encryption-example.ts
import { TokenEncryption } from "@melandlabs/opencontext";

async function main() {
  const encryptor = new TokenEncryption();

  const original = "sk-1234567890abcdef";

  // encryptToken / decryptToken are synchronous
  const encrypted = encryptor.encryptToken(original);
  console.log("Encrypted:", encrypted);

  const decrypted = encryptor.decryptToken(encrypted);
  console.log("Decrypted:", decrypted);
}

main().catch((error) => {
  console.error("Token encryption failed:", error);
  process.exit(1);
});
```

### URL Validation (SSRF Protection)

```typescript
// url-validation-example.ts
// Run with: npx tsx url-validation-example.ts
import { isTrustedStorageUrl, validateUrlForSSRF } from "@melandlabs/opencontext";

async function main() {
  // validateUrlForSSRF rejects plain HTTP, loopback and private IPs by default.
  // Pass { strictWhitelist: false } to skip the known-storage-provider whitelist.
  try {
    const safe = await validateUrlForSSRF("https://api.example.com/data", {
      strictWhitelist: false,
    });
    console.log("Safe URL:", safe.toString());
  } catch (error) {
    console.error("Unsafe URL:", error);
  }

  // Check if a storage URL is trusted
  const trusted = isTrustedStorageUrl("https://s3.amazonaws.com/my-bucket/file.txt");
  console.log("Trusted storage URL:", trusted);
}

main().catch((error) => {
  console.error("URL validation failed:", error);
  process.exit(1);
});
```

## Voice Capabilities

Voice plugins are re-exported from `@melandlabs/opencontext` for convenience. They are browser-oriented; the TTS plugin uses `HTMLAudioElement` and the STT plugin expects web `Blob` inputs, so these snippets are not runnable in a plain Node.js/CLI script.

### Text-to-Speech (Kokoro)

```typescript
// Browser-only example
import { KokoroPlugin } from "@melandlabs/opencontext";

const tts = new KokoroPlugin({ enabled: true, voice: "af_bella" });

// Speaks the text in the browser; returns a Promise that resolves when playback starts.
await tts.speak("Hello, world!");
```

### Speech-to-Text (Whisper)

`WhisperPlugin` transcribes audio using the OpenAI Whisper API (or a compatible endpoint).

```typescript
// whisper-example.ts
// Browser-only; run in an environment with Blob/File support.
import { WhisperPlugin } from "@melandlabs/opencontext";

async function main() {
  const stt = new WhisperPlugin({
    model: "whisper-1",
    apiKey: process.env.OPENAI_API_KEY,
  });

  // Load an audio file into a Blob. In the browser you can pass a File directly.
  const audioBuffer = Buffer.from(/* WAV bytes */);
  const audioBlob = new Blob([audioBuffer], { type: "audio/wav" });

  const result = await stt.transcribe({
    file: audioBlob,
    filename: "voice-input.wav",
  });

  console.log("Transcript:", result.text);
}

main().catch((error) => {
  console.error("Whisper transcription failed:", error);
  process.exit(1);
});
```

## Web Search Integration

Web search utilities are re-exported from `@melandlabs/opencontext` for convenience.

```typescript
// web-search-example.ts
// Run with: BRAVE_SEARCH_API_KEY=your-key npx tsx web-search-example.ts
import { needsRealTimeInfo, search } from "@melandlabs/opencontext";

async function main() {
  // Classify if a query needs real-time info
  const needsLive = needsRealTimeInfo("What's the weather today?");
  console.log("Needs live data:", needsLive);  // true

  // Perform web search (Brave Search API)
  if (needsLive && process.env.BRAVE_SEARCH_API_KEY) {
    const results = await search("OpenContext AI memory runtime", "web", 5);

    for (const result of results) {
      console.log(`- ${result.title}: ${result.url}`);
      console.log(`  ${result.description}`);
    }
  } else {
    console.log("Skipping live search: no BRAVE_SEARCH_API_KEY set");
  }
}

main().catch((error) => {
  console.error("Web search failed:", error);
  process.exit(1);
});
```

## Audit Logging

OpenContext writes structured audit logs to `~/.opencontext/logs/audit.jsonl`. The audit helpers are re-exported from `@melandlabs/opencontext`.

```typescript
// audit-logging-example.ts
// Run with: npx tsx audit-logging-example.ts
import { logCommandExec, logFileRead, readAuditLogs } from "@melandlabs/opencontext";

async function main() {
  logFileRead("/etc/passwd");
  logCommandExec("git", ["status"]);

  const { entries, total } = readAuditLogs({ type: "file_read", limit: 10 });
  console.log(`Total audit entries: ${total}`);
  for (const entry of entries) {
    console.log(`[${entry.type}] ${entry.detail}`);
  }
}

main().catch((error) => {
  console.error("Audit logging example failed:", error);
  process.exit(1);
});
```

Parse the audit log from the shell:

```bash
# View recent audit entries
tail -f ~/.opencontext/logs/audit.jsonl | jq

# Count file-read entries
cat ~/.opencontext/logs/audit.jsonl | jq -r 'select(.type=="file_read") | .detail' | sort | uniq -c
```

## Performance Optimization

### Batch Operations

```typescript
// batch-store-example.ts
// Run with: npx tsx batch-store-example.ts
import { getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  const messages = await getRawMessageManager();
  const now = Date.now();

  // Batch store is much faster than individual calls.
  const batch = Array.from({ length: 1000 }, (_, i) => ({
    messageId: `msg-${now}-${i}`,
    userId: "user-123",
    content: `Message ${i}`,
    platform: "test",
    botId: "test-bot",
    timestamp: now,
    createdAt: now,
  }));

  const start = Date.now();
  const ids = await messages.storeMessages(batch);
  console.log(`Stored ${ids.length} message(s) in ${Date.now() - start}ms`);
}

main().catch((error) => {
  console.error("Batch store failed:", error);
  process.exit(1);
});
```

### Embedding Caching

Avoid recomputing embeddings for repeated text by caching them. A `Map` works for short-lived processes; for production, swap in `lru-cache` or a shared cache store.

```typescript
// embedding-cache-example.ts
// Run with: npx tsx embedding-cache-example.ts
import { LocalTransformersEmbeddingProvider } from "@melandlabs/opencontext";

const embeddingCache = new Map<string, number[]>();

async function getCachedEmbedding(text: string) {
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const provider = new LocalTransformersEmbeddingProvider({
    model: "Xenova/all-MiniLM-L6-v2",
  });
  const embedding = await provider.embedQuery({ query: text });
  embeddingCache.set(text, embedding);
  return embedding;
}

async function main() {
  const text = "User prefers dark mode";

  const first = await getCachedEmbedding(text);
  console.log("First embedding dimensions:", first.length);

  const second = await getCachedEmbedding(text);
  console.log("Cache hit, same embedding:", first === second);
}

main().catch((error) => {
  console.error("Embedding cache example failed:", error);
  process.exit(1);
});
```

### Connection Pooling (Postgres)

When using the Postgres backend for raw-message storage, configure a connection pool with `postgres` + `drizzle-orm`. These are not bundled with `@melandlabs/opencontext`, so install them separately.

```typescript
// postgres-pool-example.ts
// Run with: DATABASE_URL=postgres://... npx tsx postgres-pool-example.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  // Connection pool for Postgres
  const client = postgres(databaseUrl, {
    max: 10,            // Max connections
    idle_timeout: 20,
    connect_timeout: 10,
  });

  const db = drizzle(client, { logger: true });

  // Example: run a lightweight query to verify connectivity.
  const result = await db.execute("SELECT 1 as ok");
  console.log("Connected:", result);

  await client.end();
}

main().catch((error) => {
  console.error("Postgres pool example failed:", error);
  process.exit(1);
});
```

## Monitoring

### Health Checks

```bash
# Check all subsystems
npx @melandlabs/opencontext doctor

# Check specific subsystems
npx @melandlabs/opencontext doctor --section memory-store
npx @melandlabs/opencontext doctor --section embedding
npx @melandlabs/opencontext doctor --section integrations

# JSON output for monitoring
npx @melandlabs/opencontext doctor --json | jq '.ok'
```

### Metrics

Track OpenContext usage in your own counters:

```typescript
// metrics-example.ts
// Run with: npx tsx metrics-example.ts
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

const metrics = {
  memoryWrites: 0,
  memoryRecalls: 0,
};

async function trackedRemember(userId: string, content: string) {
  const manager = await getRawMessageManager();
  metrics.memoryWrites++;
  await manager.storeMessages([{
    messageId: `msg-${Date.now()}`,
    userId,
    content,
    platform: "tracked",
    botId: "metrics-bot",
    timestamp: Date.now(),
    createdAt: Date.now(),
  }]);
}

async function trackedRecall(userId: string, query: string) {
  const store = await createMemoryStore();
  metrics.memoryRecalls++;
  const results = await store.searchUnifiedMemory({ userId, query, limit: 5 });
  await store.raw.close();
  return results;
}

async function main() {
  await trackedRemember("user-123", "User prefers TypeScript");
  const results = await trackedRecall("user-123", "What does the user prefer?");

  console.log("Metrics:", metrics);
  console.log(`Recalled ${results.count} result(s)`);

  // In a long-running process you might log metrics periodically:
  // setInterval(() => console.log("Metrics:", metrics), 60000);
}

main().catch((error) => {
  console.error("Metrics example failed:", error);
  process.exit(1);
});
```

## DeepSeek Harness Plugin

The [`dsh-opencontext`](https://github.com/melandlabs/opencontext/tree/main/plugins/dsh-opencontext) plugin gives DeepSeek Harness (DSH) agents persistent memory and retrieval-augmented generation capabilities by integrating with OpenContext.

### Prerequisites

- [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) installed
- Node.js >= 22.19.0 or >= 24.0.0

### Installation

#### From npm (recommended)

```bash
# Install directly from npm
dsh plugin --profile web add dsh-opencontext

# Start DSH Web
dsh web
```

#### From source (for development)

```bash
# Clone the repo and navigate to the plugin directory
cd plugins/dsh-opencontext

# Build the plugin
pnpm install
pnpm build

# Register with your DSH profile
dsh plugin --profile web add /path/to/opencontext/plugins/dsh-opencontext

# Start DSH Web
dsh web
# Visit http://127.0.0.1:3080/plugins to confirm the plugin is enabled
```

### Available Tools (16)

**Core Memory Tools (8)**

| Tool | Purpose |
|---|---|
| `oc_search` | Search long-term memory (unified across memory, insights, knowledge) |
| `oc_remember` | Persist one memory entry |
| `oc_memory_list` | List recent memory entries in current scope |
| `oc_memory_get` | Read one or more entries by ID |
| `oc_memory_revise` | Soft-deprecate an entry and store a successor |
| `oc_memory_retire` | Soft-deprecate an entry |
| `oc_prepare_context` | Manually build a bounded context block |
| `oc_capture_source` | Capture an arbitrary content source |

**Summary & Outcome Tools (3)**

| Tool | Purpose |
|---|---|
| `oc_session_summary` | Generate and store a session summary |
| `oc_task_outcome` | Record task outcomes, decisions, achievements |
| `oc_recent_summaries` | List recent session summaries and task outcomes |

**Insights Tools (2)**

| Tool | Purpose |
|---|---|
| `oc_insights_search` | Search structured insights (decisions, preferences, outcomes) |
| `oc_insight_capture` | Capture a structured insight from conversation |

**Knowledge/RAG Tools (3)**

| Tool | Purpose |
|---|---|
| `oc_knowledge_search` | RAG search over uploaded documents |
| `oc_document_upload` | Upload documents to knowledge base |
| `oc_document_list` | List all documents in knowledge base |

### Automatic Features

**Recall Waterfall**: Before each turn, automatically searches relevant historical memories and injects them as context.

**Auto-Capture**: Each user message is automatically written to the memory store.

**Session Summarization**: Optional automatic summarization at turn boundaries.

### Doctor Command

```
/oc doctor
```

Returns plugin status, database path, memory count, and enabled features.

### Configuration Options

| Field | Default | Environment Variable |
|---|---|---|
| `capturePrompts` | `true` | `OPENCONTEXT_DSH_CAPTURE_PROMPTS` |
| `maxRecallItems` | `8` | `OPENCONTEXT_DSH_MAX_RECALL_ITEMS` |
| `autoSummarize` | `false` | `OPENCONTEXT_DSH_AUTO_SUMMARIZE` |
| `captureToolResults` | `false` | `OPENCONTEXT_DSH_CAPTURE_TOOL_RESULTS` |
| `enableInsights` | `true` | `OPENCONTEXT_DSH_ENABLE_INSIGHTS` |
| `enableKnowledge` | `true` | `OPENCONTEXT_DSH_ENABLE_KNOWLEDGE` |

### Usage Examples

> **User**: I prefer TypeScript, remember that
> **Agent**: Got it, I'll remember that.
>
> *(Next conversation)*
> **User**: Write me a function
> **Agent**: I remember you prefer TypeScript. Here's a TS version...

> **User**: Upload my API docs
> **Agent**: *(uses oc_document_upload)* Done.
> **User**: How do I call this API?
> **Agent**: *(uses oc_knowledge_search)* According to your docs, the API is called like...

### Trust Model

Recalled memories are appended as **untrusted historical evidence**. If they contradict the user's current statement, the user always takes precedence.

## Next Steps

- 📖 [Getting Started](./00-getting-started.md) - Quick start
- 👤 [User Guide](./01-user-guide.md) - Core concepts
- 🔧 [Developer Guide](./02-developer-guide.md) - Integration
- 📚 [Best Practices](./04-best-practices.md) - Optimization

---

**Sources:**
- [ClickHelp - Best Practices for Creating Developer Documentation](https://clickhelp.com/clickhelp-technical-writing-blog/best-practices-for-creating-developer-documentation/)
- [UpGrad - Open Source Projects for Beginners](https://www.upgrad.com/blog/open-source-projects-for-beginners/)
