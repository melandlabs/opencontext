# User Guide - Understanding OpenContext

This guide explains the core concepts of OpenContext and how to use them effectively. By the end, you'll understand how to store, search, and manage temporal context, and how to build memory-aware AI agents.

## The Four Verbs of Memory

OpenContext's memory API is built around four verbs that cover every persistent memory operation:

| Verb | Purpose | Use When | SDK Method |
|------|---------|----------|------------|
| `remember` | Ingest and re-ingest facts | Storing new information | `manager.storeMessages([...])` |
| `recall` | Search, lookup, and graph traversal | Finding what's relevant | `store.searchUnifiedMemory({...})` |
| `forget` | Soft-delete and GDPR erasure | Cleaning up old data | `manager.archiveMessages([...])` |
| `improve` | Correction, supersession, and merge | Fixing outdated facts | `manager.storeMessages([...])` + `manager.deprecateMessages([...])` |

### Remember: Storing Facts

Every fact in OpenContext is a `RawMessage` - a piece of content with metadata:

```typescript
// remember-example.ts
// Run with: npx tsx remember-example.ts
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
```

**Key properties of `remember`:**

- **Idempotent on `messageId`** - Re-ingesting the same message is safe
- **Temporal by default** - Every fact gets `valid_from = now`
- **Platform-agnostic** - Works across Gmail, Slack, iMessage, etc.

### Recall: Finding What's Relevant

Search across all your data sources in one call:

```typescript
// recall-example.ts
// Run with: npx tsx recall-example.ts
import { createMemoryStore } from "@melandlabs/opencontext";

async function main() {
  const store = await createMemoryStore();

  const results = await store.searchUnifiedMemory({
    userId: "user-123",
    query: "What are the user's preferences?",
    limit: 10,
    // Optional filters
    sources: ["memory", "insights", "knowledge"],
    threshold: 0.7,
    botIds: ["my-agent"],
  });

  console.log(`Found ${results.count} results`);
  console.log(`Sources consulted: ${results.sources.join(", ")}`);

  for (const warning of results.warnings) {
    console.warn(`[${warning.source}] ${warning.message}`);
  }

  for (const hit of results.results) {
    console.log(`- ${hit.content} (score: ${hit.similarity})`);
  }
}

main().catch((error) => {
  console.error("Search failed:", error);
  process.exit(1);
});
```

**What `recall` searches:**

| Source | Contains |
|--------|-----------|
| `memory` | Raw messages you stored |
| `insights` | Derived facts extracted by agents |
| `knowledge` | Documents you uploaded |

**Graceful degradation:** If a source isn't configured, you get a warning instead of an error. Your agent always gets a response.

### Forget: Cleaning Up

Soft-delete facts while keeping them for compliance:

```typescript
// forget-example.ts
// Run with: npx tsx forget-example.ts
import { getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  const manager = await getRawMessageManager();

  // Archive marks the fact with `archived_at = now`.
  // The row stays in the database, but search excludes it by default.
  const changed = await manager.archiveMessages(
    ["msg-unique-id"],
    Date.now(),
    "user-123",
  );

  console.log(`Archived ${changed} fact(s)`);
}

main().catch((error) => {
  console.error("Forget failed:", error);
  process.exit(1);
});
```

- The fact is marked with `archived_at = now`
- Raw data remains on disk for compliance
- Future `recall` calls won't return it unless you pass `includeArchived: true`

### Improve: Updating Facts

When a fact changes, don't overwrite - append a correction:

```typescript
// improve-example.ts
// Run with: npx tsx improve-example.ts
import { getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  const manager = await getRawMessageManager();
  const now = Date.now();

  const newMessageId = `msg-${now}`;

  // 1. Store the corrected fact as a new message.
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

  // 2. Deprecate the old fact so search hides it by default.
  if (typeof manager.deprecateMessages !== "function") {
    throw new Error("This storage backend does not support deprecating messages.");
  }

  const changed = await manager.deprecateMessages(["msg-unique-id"], {
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
```

**Correction workflow:**

| Step | Action | Result |
|------|--------|--------|
| 1. Store new fact | `manager.storeMessages([...])` | New message is searchable |
| 2. Deprecate old fact | `manager.deprecateMessages([oldId], { reason })` | Old message hidden from search by default |

`deprecateMessages` is idempotent — calling it again on the same IDs returns `0` affected rows.

## The Temporal Context Graph

Unlike a flat vector database, OpenContext stores facts in a **temporal graph**. Every fact has:

- `valid_from` - When this fact became true
- `valid_until` - When this fact stopped being true (null = still true)
- `created_at` - When we recorded this fact

This enables **time-travel queries**:

```typescript
// time-travel-example.ts
// Run with: npx tsx time-travel-example.ts
import { createMemoryStore } from "@melandlabs/opencontext";

async function main() {
  const store = await createMemoryStore();

  // Ask: "What did we believe on April 1st?"
  const factsAsOfApril = await store.searchUnifiedMemory({
    userId: "user-123",
    query: "project status",
    asOf: new Date("2024-04-01").toISOString(),
  });

  console.log(`Found ${factsAsOfApril.count} fact(s) as of April 1st`);
  for (const hit of factsAsOfApril.results) {
    console.log(`- ${hit.content}`);
  }
}

main().catch((error) => {
  console.error("Time-travel query failed:", error);
  process.exit(1);
});
```

## Building AI Agents with Memory

OpenContext's `IAgent` interface lets you create AI agents that can reason, plan, and remember context.

### What is IAgent?

`IAgent` is OpenContext's agent contract - a unified interface for running AI agents:

- **Pluggable providers** - Swap between different LLM providers
- **Standardized message stream** - Consistent output format across providers
- **Memory-aware** - Agents can recall context before responding
- **Extensible** - Build custom agents with tools and planning

### Quick Start: StandaloneAgent

The simplest way to use an agent is `StandaloneAgent` - a single LLM call:

```typescript
// standalone-agent-example.ts
// Run with: OPENAI_API_KEY=your-key npx tsx standalone-agent-example.ts
import { getAgentInstance, registerAgentPlugin, standaloneAgentPlugin } from "@melandlabs/ai";

async function main() {
  // Register the built-in single-shot agent provider once per process.
  registerAgentPlugin(standaloneAgentPlugin);

  // Create an agent instance
  const agent = await getAgentInstance("standalone", {
    provider: "standalone",
    model: "openai/gpt-4o-mini",
  });

  // Run the agent
  for await (const message of agent.run("What is the capital of France?")) {
    if (message.type === "text") {
      console.log("Agent:", message.content);
    }
  }
}

main().catch((error) => {
  console.error("Agent failed:", error);
  process.exit(1);
});
```

**Message types:**

| Type | Description |
|------|-------------|
| `session` | Session started, includes `sessionId` |
| `text` | Text content from the agent |
| `result` | Final result with token usage |
| `error` | Error occurred |

### Supported Models

| Provider | Environment Variable | Example Models |
|----------|---------------------|----------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4.6` |
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-4o-mini` |
| OpenRouter | `OPENROUTER_API_KEY` | `openai/gpt-4o-mini` |

### Memory-Aware Agent

Combine `IAgent` with memory to create agents that remember context:

```typescript
// memory-aware-agent-example.ts
// Run with: OPENAI_API_KEY=your-key npx tsx memory-aware-agent-example.ts
import type { IAgent } from "@melandlabs/ai";
import { getAgentInstance, registerAgentPlugin, standaloneAgentPlugin } from "@melandlabs/ai";
import { createMemoryStore, getRawMessageManager, type MemoryStore } from "@melandlabs/opencontext";

class MemoryAwareAgent {
  private agent: IAgent | null = null;
  private store: MemoryStore | null = null;

  constructor(private userId: string) {}

  async initialize() {
    this.agent = await getAgentInstance("standalone", {
      provider: "standalone",
      model: "openai/gpt-4o-mini",
    });
    this.store = await createMemoryStore();
  }

  async ask(query: string) {
    if (!this.agent || !this.store) {
      throw new Error("Agent not initialized. Call initialize() first.");
    }

    // 1. Recall relevant context
    const context = await this.store.searchUnifiedMemory({
      userId: this.userId,
      query,
      limit: 5,
    });

    // 2. Build prompt with context
    const contextStr = context.results
      .map((r) => `- ${r.content}`)
      .join("\n");

    const prompt = `User asked: ${query}\n\nRelevant context:\n${contextStr}`;

    // 3. Run the agent
    const response: string[] = [];
    for await (const message of this.agent.run(prompt)) {
      if (message.type === "text") {
        response.push(message.content ?? "");
      }
    }

    const answer = response.join("");

    // 4. Remember this interaction
    const messages = await getRawMessageManager();
    await messages.storeMessages([{
      messageId: `msg-${Date.now()}`,
      userId: this.userId,
      content: `Q: ${query}\nA: ${answer}`,
      platform: "agent",
      botId: "memory-aware",
      timestamp: Date.now(),
      createdAt: Date.now(),
    }]);

    return answer;
  }
}

async function main() {
  registerAgentPlugin(standaloneAgentPlugin);

  const agent = new MemoryAwareAgent("user-123");
  await agent.initialize();

  const answer = await agent.ask("What do you know about me?");
  console.log("Agent:", answer);
}

main().catch((error) => {
  console.error("Memory-aware agent failed:", error);
  process.exit(1);
});
```

### Agent Patterns

#### Question-Answer Agent

```typescript
// qa-agent-example.ts
// Run with: OPENAI_API_KEY=your-key npx tsx qa-agent-example.ts
import { getAgentInstance, registerAgentPlugin, standaloneAgentPlugin } from "@melandlabs/ai";
import { createMemoryStore } from "@melandlabs/opencontext";

async function qaAgent(userId: string, question: string) {
  const agent = await getAgentInstance("standalone", {
    provider: "standalone",
    model: "openai/gpt-4o-mini",
  });

  const store = await createMemoryStore();
  const context = await store.searchUnifiedMemory({
    userId,
    query: question,
    limit: 5,
  });

  const response: string[] = [];
  for await (const msg of agent.run(
    `Answer using context:\n${context.results.map(r => r.content).join("\n")}\n\nQuestion: ${question}`
  )) {
    if (msg.type === "text") response.push(msg.content ?? "");
  }

  return response.join("");
}

async function main() {
  registerAgentPlugin(standaloneAgentPlugin);

  const answer = await qaAgent("user-123", "What are my preferences?");
  console.log("Answer:", answer);
}

main().catch((error) => {
  console.error("QA agent failed:", error);
  process.exit(1);
});
```

#### Summarization Agent

```typescript
// summarize-agent-example.ts
// Run with: ANTHROPIC_API_KEY=your-key npx tsx summarize-agent-example.ts
import { getAgentInstance, registerAgentPlugin, standaloneAgentPlugin } from "@melandlabs/ai";
import { createMemoryStore } from "@melandlabs/opencontext";

async function summarizeAgent(userId: string, _timeframe: number) {
  const agent = await getAgentInstance("standalone", {
    provider: "standalone",
    model: "anthropic/claude-sonnet-4.6",
  });

  const store = await createMemoryStore();
  const recent = await store.searchUnifiedMemory({
    userId,
    query: "recent activity and decisions",
    limit: 20,
  });

  const response: string[] = [];
  for await (const msg of agent.run(
    `Summarize these activities:\n${recent.results.map(r => r.content).join("\n")}`
  )) {
    if (msg.type === "text") response.push(msg.content ?? "");
  }

  return response.join("");
}

async function main() {
  registerAgentPlugin(standaloneAgentPlugin);

  const summary = await summarizeAgent("user-123", Date.now() - 7 * 24 * 60 * 60 * 1000);
  console.log("Summary:", summary);
}

main().catch((error) => {
  console.error("Summarize agent failed:", error);
  process.exit(1);
});
```

## Configuration Options

OpenContext can be configured for different use cases:

### Minimal: Local-only (no API keys)

```typescript
// minimal-config-example.ts
// Run with: npx tsx minimal-config-example.ts
import { createMemoryStore } from "@melandlabs/opencontext";

async function main() {
  // SQLite is the default backend. Override the path with:
  //   MEMORY_STORE_DB_PATH=./memory.db
  const store = await createMemoryStore();

  console.log("Backend:", store.raw.getBackend());

  // Search works out of the box with lexical fallback (no API keys).
  const results = await store.searchUnifiedMemory({
    userId: "user-123",
    query: "hello world",
    limit: 5,
  });

  console.log(`Found ${results.count} result(s)`);
  await store.raw.close();
}

main().catch((error) => {
  console.error("Config example failed:", error);
  process.exit(1);
});
```

### Standard: Cloud embeddings

```typescript
// cloud-embeddings-example.ts
// Run with: OPENROUTER_API_KEY=your-key npx tsx cloud-embeddings-example.ts
import { createMemoryStore } from "@melandlabs/opencontext";

async function main() {
  const store = await createMemoryStore({
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
        if (!response.ok) {
          throw new Error(`Embedding request failed: ${response.status} ${await response.text()}`);
        }
        const data = await response.json();
        return data.data[0].embedding as number[];
      },
    },
  });

  const results = await store.searchUnifiedMemory({
    userId: "user-123",
    query: "What are my preferences?",
    limit: 5,
  });

  console.log(`Found ${results.count} result(s)`);
  await store.raw.close();
}

main().catch((error) => {
  console.error("Cloud embeddings example failed:", error);
  process.exit(1);
});
```

### Full: Chroma vector store

```typescript
// chroma-config-example.ts
// Run with: npx tsx chroma-config-example.ts
// Requires a Chroma server running at http://127.0.0.1:8000
import { createMemoryStore } from "@melandlabs/opencontext";

async function main() {
  const store = await createMemoryStore({
    vector: {
      backend: "chroma",
      chroma: {
        url: "http://127.0.0.1:8000",
        rawMessagesCollection: "my_raw_messages",
      },
    },
  });

  const results = await store.searchUnifiedMemory({
    userId: "user-123",
    query: "What are my preferences?",
    limit: 5,
  });

  console.log(`Found ${results.count} result(s)`);
  await store.raw.close();
}

main().catch((error) => {
  console.error("Chroma config example failed:", error);
  process.exit(1);
});
```

## Common Patterns

### Pattern 1: Remember Everything

```typescript
// remember-everything-example.ts
// Run with: npx tsx remember-everything-example.ts
import { getRawMessageManager } from "@melandlabs/opencontext";

interface IncomingMessage {
  id: string;
  user_id: string;
  text: string;
  platform: string;
  timestamp: number;
}

async function handleIncomingMessage(msg: IncomingMessage) {
  const messages = await getRawMessageManager();

  await messages.storeMessages([{
    messageId: msg.id,
    userId: msg.user_id,
    content: msg.text,
    platform: msg.platform,
    botId: "my-bot",
    timestamp: msg.timestamp,
    createdAt: Date.now(),
  }]);

  console.log(`Stored message ${msg.id}`);
}

async function main() {
  const exampleMessage: IncomingMessage = {
    id: `msg-${Date.now()}`,
    user_id: "user-123",
    text: "User prefers dark mode",
    platform: "slack",
    timestamp: Date.now(),
  };

  await handleIncomingMessage(exampleMessage);
}

main().catch((error) => {
  console.error("Remember-everything example failed:", error);
  process.exit(1);
});
```

### Pattern 2: Recall Before Acting

```typescript
// recall-before-acting-example.ts
// Run with: OPENAI_API_KEY=your-key npx tsx recall-before-acting-example.ts
import { getAgentInstance, registerAgentPlugin, standaloneAgentPlugin } from "@melandlabs/ai";
import { createMemoryStore } from "@melandlabs/opencontext";

async function agentAction(userId: string, question: string) {
  const store = await createMemoryStore();

  // First, recall relevant context
  const context = await store.searchUnifiedMemory({
    userId,
    query: question,
    limit: 5,
  });

  // Build context string for LLM
  const contextStr = context.results
    .map((r) => `- ${r.content}`)
    .join("\n");

  // Now call your LLM with full context
  const agent = await getAgentInstance("standalone", {
    provider: "standalone",
    model: "openai/gpt-4o-mini",
  });

  const response: string[] = [];
  for await (const msg of agent.run(
    `User asked: ${question}\n\nRelevant context:\n${contextStr}`
  )) {
    if (msg.type === "text") response.push(msg.content ?? "");
  }

  return response.join("");
}

async function main() {
  registerAgentPlugin(standaloneAgentPlugin);

  const answer = await agentAction("user-123", "What are my preferences?");
  console.log("Answer:", answer);
}

main().catch((error) => {
  console.error("Recall-before-acting example failed:", error);
  process.exit(1);
});
```

### Pattern 3: Continuous Improvement

```typescript
// continuous-improvement-example.ts
// Run with: npx tsx continuous-improvement-example.ts
import { getRawMessageManager } from "@melandlabs/opencontext";

async function handleCorrection(
  userId: string,
  oldMessageId: string,
  correction: string,
) {
  const manager = await getRawMessageManager();
  const now = Date.now();
  const newMessageId = `msg-${now}`;

  // 1. Store the corrected fact.
  await manager.storeMessages([
    {
      messageId: newMessageId,
      userId,
      content: correction,
      platform: "user-correction",
      botId: "my-bot",
      timestamp: now,
      createdAt: now,
    },
  ]);

  // 2. Deprecate the outdated fact.
  if (typeof manager.deprecateMessages !== "function") {
    throw new Error("This storage backend does not support deprecating messages.");
  }

  const changed = await manager.deprecateMessages([oldMessageId], {
    userId,
    reason: "User correction",
    supersededBySummaryId: newMessageId,
  });

  console.log(`Deprecated ${changed} outdated fact(s)`);
}

async function main() {
  await handleCorrection(
    "user-123",
    "msg-unique-id",
    "User now prefers light mode",
  );
}

main().catch((error) => {
  console.error("Continuous improvement example failed:", error);
  process.exit(1);
});
```

## Understanding Warnings

OpenContext degrades gracefully. You'll see warnings when:

| Warning Code | Meaning | Fix |
|--------------|---------|-----|
| `embed_query_not_configured` | No embedder wired | Set `unified.embedQuery` |
| `raw_message_storage_unavailable` | Database not connected | Check `db` config |
| `knowledge_search_not_configured` | No RAG index | Set `unified.searchKnowledge` |
| `insights_search_not_configured` | No insight index | Set `unified.searchInsights` |

Warnings are **structured** - your code can handle them:

```typescript
// warnings-example.ts
// Run with: npx tsx warnings-example.ts
import { createMemoryStore } from "@melandlabs/opencontext";

async function main() {
  const store = await createMemoryStore();

  const results = await store.searchUnifiedMemory({
    userId: "user-123",
    query: "What are my preferences?",
    limit: 5,
  });

  for (const warning of results.warnings) {
    if (warning.code === "embed_query_not_configured") {
      console.warn("Search is limited - embeddings not available");
    } else {
      console.warn(`[${warning.source}] ${warning.code}: ${warning.message}`);
    }
  }

  console.log(`Found ${results.count} result(s)`);
  await store.raw.close();
}

main().catch((error) => {
  console.error("Warnings example failed:", error);
  process.exit(1);
});
```

## Next Steps

- 📖 [Getting Started](./00-getting-started.md) - Installation and setup
- 🔧 [Developer Guide](./02-developer-guide.md) - Integration patterns
- 🚀 [Advanced Usage](./03-advanced-usage.md) - Platform integrations
- 📚 [Best Practices](./04-best-practices.md) - Tips from the team

---

**Sources:**
- [Coding With Ryan - Writing Good Software Development Tutorials](https://codingwithryan.com/blog/writing-good-developer-tutorials)
- [Medium - Basics of Developer Documentation](https://medium.com/@shereshavodela7/basics-of-developer-documentation-5146387e3b59)
