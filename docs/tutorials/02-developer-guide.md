# Developer Guide - Building with OpenContext

This guide shows you how to integrate OpenContext into your application. We'll cover common integration patterns, backend selection, and production deployment.

## Quick Integration Checklist

Before you integrate, decide:

- [ ] **Storage backend**: SQLite (desktop), Postgres (server), or Chroma (managed)
- [ ] **Embedding provider**: Local (no API key) or cloud (OpenRouter, OpenAI)
- [ ] **Transport surface**: Direct import, HTTP server, or MCP
- [ ] **Deployment**: Self-hosted or containerized

## Integration Patterns

### Pattern 1: Embedded in a Node.js App

The simplest integration - import directly into your code:

```bash
pnpm add @melandlabs/opencontext
```

```typescript
// memory-service.ts
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

let store: Awaited<ReturnType<typeof createMemoryStore>>;

export async function initMemory() {
  store = await createMemoryStore({
    db: {
      type: "sqlite-vec",
      path: process.env.MEMORY_DB_PATH || "./memory.db",
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
```

Use it in your app:

```typescript
// app.ts
import { initMemory, rememberFact, recallFacts } from "./memory-service";

async function handleUserMessage(userId: string, message: string) {
  // Remember what the user said
  await rememberFact(userId, message);

  // Recall relevant context
  const context = await recallFacts(userId, `Context for: ${message}`);

  // Use context in your response
  return generateResponse(message, context.results);
}
```

### Pattern 2: HTTP Server (Microservice)

Run OpenContext as a standalone HTTP service:

```bash
# Start the server
opencontext http \
  --embedding-provider local \
  --memory-backend sqlite-vec \
  --host 0.0.0.0 \
  --port 7421
```

Or use `npx` without installing:

```bash
npx -y @melandlabs/opencontext http \
  --embedding-provider local \
  --memory-backend sqlite-vec
```

Call from your app:

```typescript
// memory-client.ts
const MEMORY_URL = process.env.MEMORY_URL || "http://127.0.0.1:7421";

async function recallFacts(userId: string, query: string) {
  const response = await fetch(`${MEMORY_URL}/v1/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, query, limit: 10 }),
  });

  return response.json();
}

async function rememberFact(userId: string, content: string) {
  const now = Date.now();
  const response = await fetch(`${MEMORY_URL}/v1/raw-messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId,
      embedOnInsert: true,
      messages: [{
        messageId: `msg-${now}`,
        role: "user",
        content,
        platform: "my-app",
        botId: "default",
        timestamp: now,
        createdAt: now,
      }],
    }),
  });

  return response.json();
}
```

### Pattern 3: MCP Server (for AI Agents)

Integrate with Claude Desktop, Cursor, or any MCP-compatible agent:

**Installation (Claude Desktop):**

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "opencontext": {
      "command": "npx",
      "args": [
        "-y",
        "@melandlabs/opencontext",
        "mcp",
        "--embedding-provider", "local",
        "--memory-backend", "sqlite-vec",
        "--name", "MyMemory",
        "--version", "1.0.0"
      ]
    }
  }
}
```

**Tools exposed:**

- `memory.health` - Check if the server is running
- `memory.searchUnified` - Search memory
- `memory.writeRawMessage` - Store messages
- `memory.getRawMessage` - Retrieve a message

**Using from an agent:**

```typescript
// Your agent can now call these tools via MCP
// Claude Desktop will automatically expose them
```

## Backend Selection Guide

Choose your backend based on your deployment:

### Desktop App (Tauri, Electron)

```typescript
import { createMemoryStore } from "@melandlabs/opencontext";

const store = await createMemoryStore({
  db: {
    type: "sqlite-vec",
    path: "./memory.db",  // Local file
  },
});
```

**Pros:** No external dependencies, fast local access
**Cons:** Single-user only

### Server / Multi-user

```typescript
import { createMemoryStore, registerPostgresFactory } from "@melandlabs/opencontext";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// Register Postgres factory
const client = postgres(process.env.DATABASE_URL!);
const db = drizzle(client);

registerPostgresFactory(async () => ({
  storeMessages: async (messages) => { /* your impl */ },
  getMessages: async (opts) => { /* your impl */ },
  // ... implement PostgresRawMessageManagerLike
}));

const store = await createMemoryStore({
  db: { getDb: () => db },
});
```

**Pros:** Multi-user, scalable, backups
**Cons:** Requires Postgres setup

### Managed Vector Store (Chroma)

```typescript
const store = await createMemoryStore({
  db: { type: "sqlite-vec", path: "./raw.db" },
  vector: {
    backend: "chroma",
    chroma: {
      url: process.env.CHROMA_URL || "http://127.0.0.1:8000",
      rawMessagesCollection: "raw_messages",
      insightsCollection: "insights",
    },
  },
});
```

**Pros:** Scalable vector search, separate storage
**Cons:** Additional service to run

## Configuration Examples

### Full Local Setup (No API Keys)

```typescript
import { createMemoryStore } from "@melandlabs/opencontext";
import { LocalTransformersEmbeddingProvider } from "@melandlabs/ai-rag";

const embedder = new LocalTransformersEmbeddingProvider();

const store = await createMemoryStore({
  db: {
    type: "sqlite-vec",
    path: "./memory.db",
  },
  unified: {
    embedQuery: async ({ query }) => {
      const result = await embedder.embed(query);
      return result.embedding;
    },
  },
});
```

### Cloud Embeddings (Better Quality)

```typescript
const store = await createMemoryStore({
  db: {
    type: "sqlite-vec",
    path: "./memory.db",
  },
  unified: {
    embedQuery: async ({ query }) => {
      const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: query,
        }),
      });
      const data = await response.json();
      return data.data[0].embedding;
    },
  },
});
```

## Production Deployment

### Docker Compose

```yaml
# docker-compose.yml
version: '3.8'
services:
  opencontext:
    image: node:22
    working_dir: /app
    command: npx -y @melandlabs/opencontext http --host 0.0.0.0 --port 7421 --embedding-provider local --memory-backend sqlite-vec
    volumes:
      - ./data:/app/data
    environment:
      - MEMORY_STORE_DB_PATH=/app/data/memory.db
    ports:
      - "7421:7421"
    restart: unless-stopped
```

### systemd Service

```ini
# /etc/systemd/system/opencontext.service
[Unit]
Description=OpenContext Memory Service
After=network.target

[Service]
Type=simple
User=opencontext
WorkingDirectory=/opt/opencontext
ExecStart=/usr/bin/npx -y @melandlabs/opencontext http --host 0.0.0.0 --port 7421 --embedding-provider local --memory-backend sqlite-vec
Restart=always
RestartSec=10
Environment=MEMORY_STORE_DB_PATH=/var/lib/opencontext/memory.db

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable opencontext
sudo systemctl start opencontext
sudo systemctl status opencontext
```

## Environment Variables

All CLI flags have environment variable equivalents:

| Flag | Environment Variable | Default |
|------|---------------------|---------|
| `--port` | `MEMORY_HTTP_PORT` | `7421` |
| `--host` | `MEMORY_HTTP_HOST` | `127.0.0.1` |
| `--embedding-provider` | `EMBEDDING_PROVIDER` | `none` |
| `--embedding-model` | `EMBEDDING_MODEL` | (provider default) |
| `--memory-backend` | `MEMORY_BACKEND` | `none` |
| `--insights-backend` | `INSIGHTS_BACKEND` | `none` |
| `--knowledge-backend` | `KNOWLEDGE_BACKEND` | `none` |
| `--chroma-url` | `CHROMA_URL` | (required for chroma) |

## Testing Your Integration

```typescript
// test/memory.test.ts
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";
import { describe, it, expect, beforeAll } from "vitest";

describe("Memory Integration", () => {
  let store: Awaited<ReturnType<typeof createMemoryStore>>;

  beforeAll(async () => {
    process.env.MEMORY_STORE_DB_PATH = ":memory:";  // In-memory SQLite
    store = await createMemoryStore();
  });

  it("should remember and recall facts", async () => {
    const messages = await getRawMessageManager();
    const now = Date.now();

    await messages.storeMessages([{
      messageId: "test-1",
      userId: "test-user",
      content: "Test fact",
      platform: "test",
      botId: "test-bot",
      timestamp: now,
      createdAt: now,
    }]);

    const results = await store.searchUnifiedMemory({
      userId: "test-user",
      query: "test",
      limit: 5,
    });

    expect(results.count).toBe(1);
    expect(results.results[0].content).toContain("Test");
  });
});
```

## Troubleshooting

### Module not found errors

```bash
# Reinstall dependencies
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

### Native module build failures

```bash
# Install build tools (macOS)
xcode-select --install

# Install build tools (Ubuntu)
sudo apt-get install build-essential python3

# Rebuild native modules
pnpm rebuild
```

### Database locked errors

SQLite doesn't support concurrent writes. Use:

```typescript
// Connection pooling or write queue
// Or switch to Postgres for multi-writer scenarios
```

## Next Steps

- 📖 [Getting Started](./00-getting-started.md) - Installation guide
- 👤 [User Guide](./01-user-guide.md) - Core concepts
- 🚀 [Advanced Usage](./03-advanced-usage.md) - Production patterns
- 📚 [Best Practices](./04-best-practices.md) - Optimization tips

---

**Sources:**
- [GitHub Blog - Documentation Done Right](https://github.blog/developer-skills/documentation-done-right-a-developers-guide/)
- [MDN - Getting Started Modules](https://developer.mozilla.org/en-US/docs/Learn_web_development/Getting_started)
