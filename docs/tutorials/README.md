# OpenContext Tutorials

Welcome to the OpenContext tutorial series! These guides will help you get started with OpenContext and build production-ready applications.

## Tutorial Path

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Your Learning Journey                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  1. 📖 Getting Started                                             │
│     Install OpenContext and run your first memory API call           │
│     → 00-getting-started.md                                          │
│                                                                       │
│  2. 👤 User Guide                                                   │
│     Four verbs, temporal memory, and building memory-aware agents    │
│     → 01-user-guide.md                                               │
│                                                                       │
│  3. 🔧 Developer Guide                                              │
│     Integrate OpenContext into your application                      │
│     → 02-developer-guide.md                                          │
│                                                                       │
│  4. 🚀 Advanced Usage                                               │
│     Multi-source search, temporal queries, platforms, DeepSeek Harness plugin       │
│     → 03-advanced-usage.md                                           │
│                                                                       │
│  5. 📚 Best Practices                                                │
│     Production-ready patterns and common pitfalls                     │
│     → 04-best-practices.md                                           │
│                                                                       │
│  6. 🏗️  Real-World Use Cases                                        │
│     End-to-end scenarios: Personal assistant, Support agent, Research tracker       │
│     → use-cases/                                                     │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Quick Reference by Use Case

### Core & Getting Started

| You want to... | Read this |
|----------------|------------|
| Get started in 5 minutes | [Getting Started](./00-getting-started.md) |
| Understand how memory works | [User Guide](./01-user-guide.md) |
| Understand the temporal graph model | [User Guide](./01-user-guide.md#the-temporal-context-graph) |
| Write or read memory from the CLI (`add` / `search`) | [Getting Started](./00-getting-started.md#managing-memory-from-the-cli) |

### Building Agents

| You want to... | Read this |
|----------------|------------|
| Build a memory-aware agent | [User Guide](./01-user-guide.md#building-ai-agents-with-memory) |
| Build a Q&A agent with RAG | [User Guide](./01-user-guide.md#agent-patterns) |
| Build custom agents with tools | [User Guide](./01-user-guide.md#what-is-iagent) |

### Search & Retrieval

| You want to... | Read this |
|----------------|------------|
| Search across memory + insights + knowledge | [Advanced Usage](./03-advanced-usage.md#multi-source-unified-search) |
| Use LLM reasoning to improve memory retrieval | [Advanced Usage](./03-advanced-usage.md#reasoning-backed-memory-retrieval) |
| Query as of a specific time (time-travel) | [Advanced Usage](./03-advanced-usage.md#temporal-time-travel-queries) |
| Work with the temporal graph | [Advanced Usage](./03-advanced-usage.md#working-with-the-temporal-graph) |
| Add web search to your agent | [Advanced Usage](./03-advanced-usage.md#web-search-integration) |

### Integrations & Platforms

| You want to... | Read this |
|----------------|------------|
| Add Gmail/Slack integrations | [Advanced Usage](./03-advanced-usage.md#platform-integrations) |
| Send messages through platforms | [Advanced Usage](./03-advanced-usage.md#sending-messages-write) |
| See all supported platforms | [Advanced Usage](./03-advanced-usage.md#available-platforms) |
| Use with your coding agent via MCP | [Getting Started](./00-getting-started.md#using-with-your-coding-agent-via-mcp) |

### Deployment & Operations

| You want to... | Read this |
|----------------|------------|
| Use with coding agent integration | [Getting Started](./00-getting-started.md#using-with-your-coding-agent-via-mcp) |
| Run as HTTP service | [Developer Guide](./02-developer-guide.md#pattern-2-http-server-microservice) |
| Deploy to production | [Best Practices](./04-best-practices.md) |
| Run health checks | [Advanced Usage](./03-advanced-usage.md#health-checks) |
| Set up monitoring & metrics | [Advanced Usage](./03-advanced-usage.md#monitoring) |
| Audit memory operations | [Advanced Usage](./03-advanced-usage.md#audit-logging) |

### Advanced Features

| You want to... | Read this |
|----------------|------------|
| Schedule recurring tasks with Loop | [Advanced Usage](./03-advanced-usage.md#the-loop-engine) |
| Add voice capabilities (TTS/STT) | [Advanced Usage](./03-advanced-usage.md#voice-capabilities) |
| Encrypt tokens and secrets | [Advanced Usage](./03-advanced-usage.md#encryption-and-security) |
| Optimize performance | [Advanced Usage](./03-advanced-usage.md#performance-optimization) |

### Framework Integrations

| You want to... | Read this |
|----------------|------------|
| Use with DeepSeek Harness | [Advanced Usage](./03-advanced-usage.md#deepseek-harness-plugin) |

### Real-World Use Cases

| You want to... | Read this |
|----------------|------------|
| Build a personal memory assistant | [Personal Memory Assistant](./use-cases/05-personal-memory-assistant.md) |
| Build a customer support agent | [Customer Support Agent](./use-cases/06-customer-support-agent.md) |
| Build a research knowledge tracker | [Research Knowledge Tracker](./use-cases/07-research-tracker.md) |
| See all use cases | [Use Cases Index](./use-cases/) |

## Tutorial Contents

| Tutorial | Focus | Key Topics |
|----------|-------|------------|
| [00-getting-started.md](./00-getting-started.md) | Quick Start | Installation, first API call, HTTP server, MCP, CLI `add` / `search` |
| [01-user-guide.md](./01-user-guide.md) | Core Concepts | Four verbs, temporal graph, IAgent, memory-aware agents |
| [02-developer-guide.md](./02-developer-guide.md) | Integration | Embedding, HTTP server, MCP, backend selection |
| [03-advanced-usage.md](./03-advanced-usage.md) | Advanced Features | Multi-source search, reasoning-backed retrieval, temporal queries, platforms, DeepSeek Harness plugin |
| [04-best-practices.md](./04-best-practices.md) | Production | Idempotency, performance, security, deployment |
| **Use Cases** | **Real-World Applications** | **End-to-end scenarios** |
| [05-personal-memory-assistant.md](./use-cases/05-personal-memory-assistant.md) | Individual | Preferences, notes, time-travel, metadata |
| [06-customer-support-agent.md](./use-cases/06-customer-support-agent.md) | Multi-user | Customer profiles, history tracking, repeat detection |
| [07-research-tracker.md](./use-cases/07-research-tracker.md) | Knowledge Management | Findings, citations, evolution tracking, synthesis |

## Prerequisites

Before starting any tutorial:

1. **Node.js** >= 22
2. **pnpm** >= 9.0.0 (recommended) or npm/yarn

See [Getting Started](./00-getting-started.md#prerequisites) for platform-specific prerequisites (Windows, macOS, Linux).

## Time Commitment

| Tutorial | Time to Complete |
|----------|------------------|
| Getting Started | 10-15 minutes |
| User Guide | 30-45 minutes |
| Developer Guide | 30-45 minutes |
| Advanced Usage | 45-60 minutes |
| Best Practices | 20-30 minutes |
| **Total** | **~2-3 hours** |

## Getting Help

If you get stuck:

- 📖 Check the main project [README](../../README.md)
- 💬 Join our [Discord](https://discord.com/invite/xkJaJyWcsv)
- 🐛 [Open an issue](https://github.com/melandlabs/opencontext/issues)

## Contributing

Found an error or want to improve the tutorials? Contributions welcome!

1. Fork the repository
2. Edit the tutorial file
3. Submit a pull request

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines.

---

**Next:** Start with [Getting Started](./00-getting-started.md) or jump to [User Guide](./01-user-guide.md) to learn about memory and agents.
