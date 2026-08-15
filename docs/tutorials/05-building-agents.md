# Building AI Agents with OpenContext

This guide shows you how to use OpenContext's Agent Runtime to build AI agents that can reason, plan, and execute tasks using the memory API.

## What is IAgent?

`IAgent` is OpenContext's agent contract - a unified interface for running AI agents. It provides:

- **Pluggable providers** - Swap between different LLM providers
- **Standardized message stream** - Consistent output format across providers
- **Plan management** - For agents that support multi-step planning
- **Sandbox integration** - Safe code execution in isolated environments

## Quick Start

### Using StandaloneAgent (Single-Shot LLM)

The simplest way to use an agent is `StandaloneAgent` - a single LLM call without tools or planning:

```typescript
import {
  getAgentInstance,
  StandaloneAgent,
} from "@melandlabs/opencontext";

// Create an agent instance
const agent = await getAgentInstance("standalone", {
  provider: "standalone",
  model: "openai/gpt-4o-mini",
});

// Run the agent
for await (const message of agent.run("What is the capital of France?")) {
  if (message.type === "text") {
    console.log("Agent:", message.content);
  } else if (message.type === "result") {
    console.log("Tokens:", message.usage);
  }
}
```

**Message types:**

| Type | Description |
|------|-------------|
| `session` | Session started, includes `sessionId` |
| `text` | Text content from the agent |
| `result` | Final result with token usage and timing |
| `error` | Error occurred |

## Agent Configuration

### AgentConfig

```typescript
interface AgentConfig {
  provider: string;           // Provider name (e.g., "standalone")
  model: string;              // Model identifier
  providerConfig?: {          // Provider-specific options
    isNativeMode?: boolean;   // Use native Claude mode
    // ... other provider options
  };
}
```

### Supported Models

StandaloneAgent supports any model exposed via these environment variables:

| Provider | Environment Variable | Example Models |
|----------|---------------------|----------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4.6` |
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-4o-mini` |
| OpenRouter | `OPENROUTER_API_KEY` | `openai/gpt-4o-mini` |

## Agent Registry

OpenContext includes a plugin system for registering custom agent providers:

```typescript
import { defineAgentPlugin, registerAgentPlugin } from "@melandlabs/opencontext";

// Define a custom agent plugin
const myAgentPlugin = defineAgentPlugin({
  metadata: {
    type: "my-custom-agent",
    name: "My Custom Agent",
    supportsPlan: true,      // Supports multi-step planning
    supportsStreaming: false, // No streaming support
    supportsSandbox: false,  // No sandbox support
  },
  factory: (config) => new MyCustomAgent(config),
});

// Register the plugin
registerAgentPlugin(myAgentPlugin);

// Now available via getAgentInstance
const agent = await getAgentInstance("my-custom-agent", {
  provider: "my-custom-agent",
  model: "my-model",
});
```

## Building a Memory-Aware Agent

Combine `IAgent` with the memory API to create agents that remember context:

```typescript
import {
  getAgentInstance,
  type AgentMessage,
} from "@melandlabs/opencontext";
import { createMemoryStore } from "@melandlabs/opencontext";

class MemoryAwareAgent {
  private agent: IAgent;
  private store: Awaited<ReturnType<typeof createMemoryStore>>;

  constructor(userId: string) {
    this.agent = await getAgentInstance("standalone", {
      provider: "standalone",
      model: "openai/gpt-4o-mini",
    });
    this.store = await createMemoryStore();
  }

  async run(query: string, userId: string) {
    // 1. Recall relevant context
    const context = await this.store.searchUnifiedMemory({
      userId,
      query,
      limit: 5,
    });

    // 2. Build prompt with context
    const contextStr = context.results
      .map((r) => `- ${r.content}`)
      .join("\n");

    const prompt = `User asked: ${query}\n\nRelevant context:\n${contextStr}\n\nAnswer the user's question based on the context above.`;

    // 3. Run the agent
    const response: string[] = [];
    for await (const message of this.agent.run(prompt)) {
      if (message.type === "text") {
        response.push(message.content ?? "");
      }
    }

    // 4. Remember the interaction
    const messages = await getRawMessageManager();
    await messages.storeMessages([
      {
        messageId: `interaction-${Date.now()}`,
        userId,
        content: `Q: ${query}\nA: ${response.join("")}`,
        platform: "agent",
        botId: "memory-aware",
        timestamp: Date.now(),
        createdAt: Date.now(),
      },
    ]);

    return response.join("");
  }
}
```

## Creating a Custom Agent

Implement the `IAgent` interface to create a custom agent:

```typescript
import { BaseAgent, type IAgent, type AgentConfig, type AgentMessage } from "@melandlabs/opencontext";

class MyCustomAgent extends BaseAgent {
  constructor(config: AgentConfig) {
    super(config);
    // Your initialization
  }

  get provider(): string {
    return "my-custom";
  }

  async *run(
    prompt: string,
    options?: { abortController?: AbortController },
  ): AsyncGenerator<AgentMessage> {
    yield { type: "session", sessionId: "my-session" };

    try {
      // Your agent logic here
      const response = await this.callMyLLM(prompt);

      yield { type: "text", content: response };

      yield {
        type: "result",
        usage: { inputTokens: 10, outputTokens: 20 },
        duration: 100,
      };
    } catch (error) {
      yield { type: "error", message: String(error) };
    }
  }

  // Optional methods for planning and execution
  async plan(prompt: string): Promise<string> {
    return "Plan goes here";
  }

  async execute(plan: string): Promise<string> {
    return "Execution result";
  }

  stop(): void {
    // Clean up resources
  }
}
```

## Agent Patterns

### Pattern 1: Question-Answer Agent

```typescript
async function qaAgent(question: string, userId: string) {
  const agent = await getAgentInstance("standalone", {
    provider: "standalone",
    model: "openai/gpt-4o-mini",
  });

  const store = await createMemoryStore();
  const context = await store.searchUnifiedMemory({ userId, query: question, limit: 5 });

  const response = [];
  for await (const msg of agent.run(`Answer using context:\n${context.results.map(r => r.content).join("\n")}\n\nQuestion: ${question}`)) {
    if (msg.type === "text") response.push(msg.content);
  }

  return response.join("");
}
```

### Pattern 2: Summarization Agent

```typescript
async function summarizeAgent(userId: string, timeframe: number) {
  const agent = await getAgentInstance("standalone", {
    provider: "standalone",
    model: "anthropic/claude-sonnet-4.6",
  });

  const store = await createMemoryStore();
  const cutoff = Date.now() - timeframe;

  // Get recent messages (you'd implement time filtering)
  const recent = await store.searchUnifiedMemory({
    userId,
    query: "recent activity and decisions",
    limit: 20,
  });

  const response = [];
  for await (const msg of agent.run(`Summarize these activities:\n${recent.results.map(r => r.content).join("\n")}`)) {
    if (msg.type === "text") response.push(msg.content);
  }

  return response.join("");
}
```

### Pattern 3: Tool-Calling Agent

While `StandaloneAgent` doesn't support tools, you can implement a tool-calling agent:

```typescript
class ToolCallingAgent extends BaseAgent {
  async *run(prompt: string): AsyncGenerator<AgentMessage> {
    yield { type: "session", sessionId: "tool-session" };

    // 1. Decide which tools to use
    const toolPlan = await this.decideTools(prompt);

    // 2. Execute tools
    const toolResults = await this.executeTools(toolPlan);

    // 3. Generate final response
    const response = await this.generateResponse(prompt, toolResults);

    yield { type: "text", content: response };
    yield { type: "result", duration: Date.now() };
  }

  private async decideTools(prompt: string): Promise<string[]> {
    // Use LLM to decide which tools to call
    return [];
  }

  private async executeTools(tools: string[]): Promise<any> {
    // Execute the tools and return results
    return {};
  }

  private async generateResponse(prompt: string, toolResults: any): Promise<string> {
    // Generate final response with tool results
    return "Response";
  }
}
```

## Error Handling

Agents emit `error` messages when something goes wrong:

```typescript
for await (const message of agent.run(prompt)) {
  if (message.type === "error") {
    console.error("Agent error:", message.message);
    // Handle error appropriately
    break;
  }
}
```

Common errors:
- Missing API key
- Model not available
- Rate limiting
- Network timeout

## Streaming vs Non-Streaming

`StandaloneAgent` is non-streaming by default. For streaming responses, check your provider's capabilities:

```typescript
// Check if streaming is supported
const metadata = STANDALONE_METADATA;
console.log("Supports streaming:", metadata.supportsStreaming); // false
```

## Testing Agents

```typescript
import { getAgentInstance } from "@melandlabs/opencontext";

describe("MyAgent", () => {
  it("should respond to a simple query", async () => {
    const agent = await getAgentInstance("standalone", {
      provider: "standalone",
      model: "openai/gpt-4o-mini",
    });

    const messages: AgentMessage[] = [];
    for await (const msg of agent.run("Say 'hello'")) {
      messages.push(msg);
    }

    expect(messages.some(m => m.type === "text")).toBe(true);
    expect(messages.some(m => m.type === "result")).toBe(true);
  });
});
```

## Best Practices

1. **Always handle `error` messages** - Agents can fail for many reasons
2. **Check for API keys before running** - Skip gracefully if not configured
3. **Use `abortController` for long runs** - Allow users to cancel
4. **Cache agent instances** - Reuse instances when possible
5. **Log session IDs** - Useful for debugging and tracing

```typescript
// Good practice: AbortController
const ac = new AbortController();
const timeout = setTimeout(() => ac.abort(), 30000); // 30s timeout

try {
  for await (const msg of agent.run(prompt, { abortController: ac })) {
    console.log(`[${msg.sessionId}]`, msg);
  }
} finally {
  clearTimeout(timeout);
}
```

## Next Steps

- 📖 [Getting Started](./00-getting-started.md) - Quick start
- 👤 [User Guide](./01-user-guide.md) - Memory concepts
- 🔧 [Developer Guide](./02-developer-guide.md) - Integration
- 🚀 [Advanced Usage](./03-advanced-usage.md) - Platform integrations
- 📚 [Best Practices](./04-best-practices.md) - Production tips

---

**See also:** [`@melandlabs/ai` package documentation](../../packages/ai/README.md)
