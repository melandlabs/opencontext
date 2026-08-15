# User Guide - Understanding OpenContext

This guide explains the core concepts of OpenContext and how to use them effectively. By the end, you'll understand how to store, search, and manage temporal context, and how to build memory-aware AI agents.

## The Four Verbs of Memory

OpenContext's memory API is built around four verbs that cover every persistent memory operation:

| Verb | Purpose | Use When |
|------|---------|----------|
| `remember` | Ingest and re-ingest facts | Storing new information |
| `recall` | Search, lookup, and graph traversal | Finding what's relevant |
| `forget` | Soft-delete and GDPR erasure | Cleaning up old data |
| `improve` | Correction, supersession, and merge | Fixing outdated facts |

### Remember: Storing Facts

Every fact in OpenContext is a `RawMessage` - a piece of content with metadata:

```typescript
import { getRawMessageManager } from "@melandlabs/opencontext";

async function rememberExample() {
  const messages = await getRawMessageManager();
  const now = Date.now();

  await messages.storeMessages([
    {
      // Required fields
      messageId: "msg-unique-id",    // Makes re-ingest idempotent
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
}
```

**Key properties of `remember`:**

- **Idempotent on `messageId`** - Re-ingesting the same message is safe
- **Temporal by default** - Every fact gets `valid_from = now`
- **Platform-agnostic** - Works across Gmail, Slack, iMessage, etc.

### Recall: Finding What's Relevant

Search across all your data sources in one call:

```typescript
import { createMemoryStore } from "@melandlabs/opencontext";

async function recallExample() {
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
    console.log(`- ${hit.content} (score: ${hit.score})`);
  }
}
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
import { forget } from "@melandlabs/opencontext";

async function forgetExample() {
  // Mark a fact as no longer true
  await forget({
    userId: "user-123",
    messageId: "msg-unique-id",
    scope: "user",  // or "organization", "global"
  });
}
```

- The fact is marked with `valid_until = now`
- Raw data remains on disk for compliance
- Future `recall` calls won't return it

### Improve: Updating Facts

When a fact changes, don't overwrite - append a correction:

```typescript
import { improve } from "@melandlabs/opencontext";

async function improveExample() {
  // User changed their mind - supersede the old fact
  await improve({
    userId: "user-123",
    messageId: "msg-unique-id",
    correction: {
      type: "supersedes",
      reason: "User updated preference",
      newValue: "User now prefers light mode",
    },
  });
}
```

**Correction types:**

| Type | Meaning |
|------|---------|
| `supersedes` | The new fact replaces the old one |
| `contradicts` | The new fact conflicts with the old one (both kept) |
| `extends` | The new fact adds detail to the old one (both kept) |

## The Temporal Context Graph

Unlike a flat vector database, OpenContext stores facts in a **temporal graph**. Every fact has:

- `valid_from` - When this fact became true
- `valid_until` - When this fact stopped being true (null = still true)
- `created_at` - When we recorded this fact

This enables **time-travel queries**:

```typescript
// Ask: "What did we believe on April 1st?"
const factsAsOfApril = await store.searchUnifiedMemory({
  userId: "user-123",
  query: "project status",
  asOf: new Date("2024-04-01").getTime(),
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
import { getAgentInstance } from "@melandlabs/ai";

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
import { getAgentInstance } from "@melandlabs/ai";
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

class MemoryAwareAgent {
  constructor(userId: string) {
    this.agent = null;
    this.store = null;
    this.userId = userId;
  }

  async initialize() {
    this.agent = await getAgentInstance("standalone", {
      provider: "standalone",
      model: "openai/gpt-4o-mini",
    });
    this.store = await createMemoryStore();
  }

  async ask(query: string) {
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
    const response = [];
    for await (const message of this.agent.run(prompt)) {
      if (message.type === "text") {
        response.push(message.content ?? "");
      }
    }

    // 4. Remember this interaction
    const messages = await getRawMessageManager();
    await messages.storeMessages([{
      messageId: `msg-${Date.now()}`,
      userId: this.userId,
      content: `Q: ${query}\nA: ${response.join("")}`,
      platform: "agent",
      botId: "memory-aware",
      timestamp: Date.now(),
      createdAt: Date.now(),
    }]);

    return response.join("");
  }
}
```

### Agent Patterns

#### Question-Answer Agent

```typescript
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

  const response = [];
  for await (const msg of agent.run(
    `Answer using context:\n${context.results.map(r => r.content).join("\n")}\n\nQuestion: ${question}`
  )) {
    if (msg.type === "text") response.push(msg.content);
  }

  return response.join("");
}
```

#### Summarization Agent

```typescript
async function summarizeAgent(userId: string, timeframe: number) {
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

  const response = [];
  for await (const msg of agent.run(
    `Summarize these activities:\n${recent.results.map(r => r.content).join("\n")}`
  )) {
    if (msg.type === "text") response.push(msg.content);
  }

  return response.join("");
}
```

## Configuration Options

OpenContext can be configured for different use cases:

### Minimal: Local-only (no API keys)

```typescript
const store = await createMemoryStore({
  db: { type: "sqlite-vec", path: "./memory.db" },
});
```

### Standard: Cloud embeddings

```typescript
const store = await createMemoryStore({
  db: { type: "sqlite-vec", path: "./memory.db" },
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

### Full: Chroma vector store

```typescript
const store = await createMemoryStore({
  db: { type: "sqlite-vec", path: "./memory.db" },
  vector: {
    backend: "chroma",
    chroma: {
      url: "http://127.0.0.1:8000",
      rawMessagesCollection: "my_raw_messages",
    },
  },
});
```

## Common Patterns

### Pattern 1: Remember Everything

```typescript
async function handleIncomingMessage(msg: any) {
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
}
```

### Pattern 2: Recall Before Acting

```typescript
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
  const response = await callLLM({
    prompt: `User asked: ${question}\n\nRelevant context:\n${contextStr}`,
  });

  return response;
}
```

### Pattern 3: Continuous Improvement

```typescript
async function handleCorrection(userId: string, messageId: string, correction: string) {
  await improve({
    userId,
    messageId,
    correction: {
      type: "supersedes",
      reason: "User correction",
      newValue: correction,
    },
  });
}
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
const results = await store.searchUnifiedMemory({ ... });

for (const warning of results.warnings) {
  if (warning.code === "embed_query_not_configured") {
    console.warn("Search is limited - embeddings not available");
  }
}
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
