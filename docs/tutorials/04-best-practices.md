# Best Practices - Production-Ready Patterns

This guide shares best practices learned from running OpenContext in production. Follow these patterns to build reliable, performant applications.

## Core Principles

### 1. Use messageId for Idempotency

Always provide a unique, stable `messageId` for each fact:

```typescript
// ❌ BAD: No messageId, can't safely re-ingest
await messages.storeMessages([{
  content: "User prefers dark mode",
  userId: "user-123",
  // ... no messageId
}]);

// ✅ GOOD: Stable, unique messageId
await messages.storeMessages([{
  messageId: `${userId}-${platform}-${externalId}`,
  content: "User prefers dark mode",
  userId: "user-123",
  platform: "slack",
  timestamp: Date.now(),
  createdAt: Date.now(),
}]);
```

**Why:** Re-ingesting the same message is safe and won't create duplicates.

### 2. Handle Warnings Gracefully

OpenContext degrades gracefully - never ignore warnings:

```typescript
const results = await store.searchUnifiedMemory({
  userId: "user-123",
  query: "preferences",
  limit: 10,
});

// ✅ GOOD: Handle warnings appropriately
for (const warning of results.warnings) {
  switch (warning.code) {
    case "embed_query_not_configured":
      // Fall back to keyword search
      logger.warn("Embeddings unavailable, using keyword search");
      break;
    case "raw_message_storage_unavailable":
      // Alert ops but continue
      alertOps("Memory storage unavailable");
      break;
  }
}

// ❌ BAD: Silently ignore warnings
const results = await store.searchUnifiedMemory({ ... });
// No warning handling
```

### 3. Choose the Right Backend

| Use Case | Recommended Backend |
|----------|---------------------|
| Desktop app | SQLite-vec |
| Single-user server | SQLite-vec |
| Multi-user server | Postgres + pgvector |
| Cloud-native | Chroma |
| Browser | IndexedDB |

```typescript
// ✅ GOOD: Match backend to use case
const store = await createMemoryStore({
  dbPath: isDesktop() ? "./memory.db" : undefined,
  db: isDesktop() ? undefined : { getDb: () => postgresDb },
});

// ❌ BAD: Use Postgres for desktop app
const store = await createMemoryStore({
  db: { getDb: () => postgresDb },  // Overkill for desktop
});
```

## Performance Best Practices

### 4. Batch Writes

Write in batches, not one-by-one:

```typescript
// ❌ BAD: One request per message
for (const msg of messages) {
  await messages.storeMessages([msg]);  // N network calls
}

// ✅ GOOD: Batch all writes
await messages.storeMessages(messages);  // 1 network call
```

### 5. Cache Embeddings

Embeddings are expensive - cache them:

```typescript
import { LRUCache } from "lru-cache";

const embeddingCache = new LRUCache<string, number[]>({
  max: 1000,
  ttl: 1000 * 60 * 60,  // 1 hour
});

async function embedWithCache(text: string) {
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const embedding = await embedder.embed(text);
  embeddingCache.set(text, embedding);
  return embedding;
}
```

### 6. Use Appropriate Limits

```typescript
// ✅ GOOD: Reasonable limits for UI
const results = await store.searchUnifiedMemory({
  userId: "user-123",
  query: "recent messages",
  limit: 10,  // UI typically shows 5-20 results
  threshold: 0.7,  // Filter low-quality matches
});

// ❌ BAD: Excessive limits
const results = await store.searchUnifiedMemory({
  limit: 10000,  // Too many results, slow
  threshold: 0.1,  // Too permissive, poor quality
});
```

## Security Best Practices

### 7. Encrypt Secrets at Rest

```typescript
import { TokenEncryption } from "@melandlabs/opencontext";

// ✅ GOOD: Encrypt API keys before storage
// TokenEncryption reads ENCRYPTION_KEY from the environment.
const encryptor = new TokenEncryption();
const encrypted = encryptor.encryptToken(apiKey);
await database.save({ userId, encryptedToken: encrypted });

// ❌ BAD: Store secrets in plain text
await database.save({ userId, apiToken });  // Dangerous!
```

### 8. Validate URLs (SSRF Protection)

```typescript
import { validateUrlForSSRF } from "@melandlabs/opencontext";

// ✅ GOOD: Validate URLs before calling
// The default mode enforces HTTPS and blocks private/loopback targets.
// Use { strictWhitelist: false } to skip the known-storage-provider whitelist.
try {
  const safeUrl = await validateUrlForSSRF(userProvidedUrl, { strictWhitelist: false });
  await fetch(safeUrl.toString());
} catch (error) {
  console.error("Blocked potentially unsafe URL:", error);
}

// ❌ BAD: Call user-provided URLs directly
await fetch(userProvidedUrl);  // SSRF vulnerability!
```

### 9. Use Least-Privilege Policies

```typescript
// ✅ GOOD: Restrict who can write to memory graph
process.env.MEMORY_GRAPH_WRITE_POLICY = "agent-only";

// ❌ BAD: Allow anyone to write
process.env.MEMORY_GRAPH_WRITE_POLICY = "allow-all";
```

## Data Modeling Best Practices

### 10. Store Facts, Not Chunks

```typescript
// ❌ BAD: Store arbitrary chunks
await messages.storeMessages([{
  messageId: "chunk-1",
  content: "... partial sentence fragment ...",
}]);

// ✅ GOOD: Store complete facts
await messages.storeMessages([{
  messageId: "fact-1",
  content: "The user prefers dark mode across all applications",
  metadata: {
    source: "user_profile",
    confidence: 0.95,
  },
}]);
```

### 11. Use Metadata Effectively

```typescript
await messages.storeMessages([{
  messageId: "msg-1",
  content: "Meeting decision: Use TypeScript for new project",
  metadata: {
    type: "decision",
    project: "new-project",
    meetingId: "meeting-123",
    participants: ["alice", "bob"],
    importance: "high",
  },
  // ...
}]);
```

### 12. Structure User IDs Consistently

```typescript
// ✅ GOOD: Include source in userId
const userId = `slack|user|${slackUserId}`;  // "slack|user|U123456"
const userId = `gmail|user|${emailAddress}`;  // "gmail|user|example@gmail.com"

// ❌ BAD: Inconsistent formats
const userId = slackUserId;  // Just the ID, no source
const userId = email;  // Sometimes email, sometimes ID
```

## Testing Best Practices

### 13. Use In-Memory Databases for Tests

```typescript
// ✅ GOOD: In-memory SQLite for tests
process.env.MEMORY_STORE_DB_PATH = ":memory:";
const store = await createMemoryStore();

// ❌ BAD: Real database in tests
process.env.MEMORY_STORE_DB_PATH = "./production.db";
const store = await createMemoryStore();
```

### 14. Test Warning Scenarios

```typescript
it("handles missing embedder gracefully", async () => {
  const store = await createMemoryStore({
    unified: {
      // No embedQuery - should produce warning
    },
  });

  const results = await store.searchUnifiedMemory({
    userId: "test-user",
    query: "test",
    limit: 10,
  });

  expect(results.warnings).toContainEqual(
    expect.objectContaining({
      code: "embed_query_not_configured",
    })
  );
  // But results should still be returned
  expect(results.results).toBeDefined();
});
```

### 15. Mock External Services

```typescript
import { createMinimalContext } from "@melandlabs/opencontext";

// ✅ GOOD: Mock integrations in tests
const mockIntegrations = {
  isConnected: vi.fn().mockResolvedValue(true),
  fetchMessages: vi.fn().mockResolvedValue([]),
};

// ❌ BAD: Real API calls in tests
const context = await createMinimalContext({
  /* real credentials */
});  // Real calls!
```

## Monitoring Best Practices

### 16. Use the Doctor Command

```bash
# ✅ GOOD: Regular health checks
npx @melandlabs/opencontext doctor --json | jq '.ok'  # CI-friendly

# Check specific subsystems
npx @melandlabs/opencontext doctor --section memory-store
npx @melandlabs/opencontext doctor --section integrations
```

### 17. Log Important Events

```typescript
import { logFileRead, logCommandExec } from "@melandlabs/opencontext";

// ✅ GOOD: Log critical operations
logFileRead("/sensitive/config.json");
logCommandExec("deploy", ["--env", "production"]);

// ❌ BAD: No audit trail
await improve({ userId, messageId, correction });
// No logging!
```

### 18. Track Metrics

```typescript
// ✅ GOOD: Track key metrics
const metrics = {
  writes: 0,
  reads: 0,
  corrections: 0,
  errors: 0,
};

async function trackedRemember(...args) {
  metrics.writes++;
  try {
    return await rememberFact(...args);
  } catch (err) {
    metrics.errors++;
    throw err;
  }
}

// Report metrics periodically
setInterval(() => {
  console.log("[metrics]", metrics);
}, 60000);
```

## Deployment Best Practices

### 19. Use Environment Variables for Config

```bash
# ✅ GOOD: Environment-based config
MEMORY_STORE_DB_PATH=/data/memory.db
EMBEDDING_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...

# ❌ BAD: Hard-coded config
# Config in source code
```

### 20. Run Health Checks in CI

```yaml
# .github/workflows/test.yml
- name: Run OpenContext doctor
  run: npx @melandlabs/opencontext doctor --json | jq -e '.ok == true'
```

### 21. Use Restart Policies

```yaml
# docker-compose.yml
services:
  opencontext:
    restart: unless-stopped  # ✅ GOOD
    # restart: "no"  # ❌ BAD
```

## Common Pitfalls

### ❌ Don't: Ignore the Temporal Nature

```typescript
// ❌ BAD: Overwrite facts
await messages.storeMessages([{
  messageId: "same-id",
  content: "Updated fact",
  // ... assumes overwrite behavior
}]);
```

```typescript
// ✅ GOOD: Use corrections for updates
await improve({
  messageId: "original-id",
  correction: {
    type: "supersedes",
    newValue: "Updated fact",
    reason: "User updated preference",
  },
});
```

### ❌ Don't: Mix User IDs Across Sources

```typescript
// ❌ BAD: Same user ID, different sources
await rememberFact("user-123", "Prefers dark mode", "slack");
await rememberFact("user-123", "Prefers light mode", "gmail");
// Conflict! Which is true?

// ✅ GOOD: Source-specific user IDs
await rememberFact("slack|user|123", "Prefers dark mode", "slack");
await rememberFact("gmail|user|123@example.com", "Prefers light mode", "gmail");
```

### ❌ Don't: Store Binary Data in Content

```typescript
// ❌ BAD: Large blobs in content
await messages.storeMessages([{
  content: entirePDFString,  // Can be MB!
}]);

// ✅ GOOD: Store reference to blob
await messages.storeMessages([{
  content: "User uploaded document 'report.pdf'",
  metadata: {
    blobUrl: "s3://...",
    mimeType: "application/pdf",
    size: 1024000,
  },
}]);
```

## Checklist for Production

Before deploying to production:

- [ ] All messages have stable `messageId`s
- [ ] Warnings are handled, not ignored
- [ ] Backend matches use case (SQLite for desktop, Postgres for server)
- [ ] Secrets are encrypted at rest
- [ ] URLs are validated before calling
- [ ] Tests use in-memory databases
- [ ] Doctor command runs successfully
- [ ] Health checks are in CI/CD
- [ ] Metrics are being collected
- [ ] Restart policy is configured
- [ ] Environment variables are documented
- [ ] Audit logging is enabled

## Next Steps

- 📖 [Getting Started](./00-getting-started.md) - Quick start
- 👤 [User Guide](./01-user-guide.md) - Core concepts
- 🔧 [Developer Guide](./02-developer-guide.md) - Integration
- 🚀 [Advanced Usage](./03-advanced-usage.md) - Production patterns

---

**Sources:**
- [Write the Docs - Getting Started Guide](https://www.writethedocs.org/guide/starting/)
- [Coding With Ryan - Writing Good Software Development Tutorials](https://codingwithryan.com/blog/writing-good-developer-tutorials)
- [GitHub Blog - Documentation Done Right](https://github.blog/developer-skills/documentation-done-right-a-developers-guide/)
