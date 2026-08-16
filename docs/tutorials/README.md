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
│     Multi-source search, temporal queries, platforms, DSH plugin       │
│     → 03-advanced-usage.md                                           │
│                                                                       │
│  5. 📚 Best Practices                                                │
│     Production-ready patterns and common pitfalls                     │
│     → 04-best-practices.md                                           │
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

### Building Agents

| You want to... | Read this |
|----------------|------------|
| Build a memory-aware agent | [User Guide](./01-user-guide.md#building-ai-agents-with-memory) |
| Build a Q&A agent with RAG | [User Guide](./01-user-guide.md#agent-patterns) |
| Create custom agent provider | [User Guide](./01-user-guide.md#creating-a-custom-agent) |

### Search & Retrieval

| You want to... | Read this |
|----------------|------------|
| Search across memory + insights + knowledge | [Advanced Usage](./03-advanced-usage.md#multi-source-unified-search) |
| Query as of a specific time (time-travel) | [Advanced Usage](./03-advanced-usage.md#temporal-time-travel-queries) |
| Work with the temporal graph | [Advanced Usage](./03-advanced-usage.md#working-with-the-temporal-graph) |
| Add web search to your agent | [Advanced Usage](./03-advanced-usage.md#web-search-integration) |

### Integrations & Platforms

| You want to... | Read this |
|----------------|------------|
| Add Gmail/Slack integrations | [Advanced Usage](./03-advanced-usage.md#platform-integrations) |
| Send messages through platforms | [Advanced Usage](./03-advanced-usage.md#sending-messages-write) |
| See all 27+ supported platforms | [Advanced Usage](./03-advanced-usage.md#available-platforms) |
| Use with your coding agent via MCP | [Getting Started](./00-getting-started.md#using-with-your-coding-agent-via-mcp) |

### Deployment & Operations

| You want to... | Read this |
|----------------|------------|
| Use with Claude Desktop | [Getting Started](./00-getting-started.md#using-with-claude-desktop-mcp) |
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

### OpenLoomi Use Cases

| You want to... | Reference |
|----------------|------------|
| Build a cross-platform desktop agent | [OpenLoomi GitHub](https://github.com/melandlabs/openloomi) |
| Unify context across Gmail/Slack/Linear/Notion | [OpenLoomi README](https://github.com/melandlabs/openloomi#features) |
| Create automated morning briefings | See Loop Engine section |
| Send summaries via Telegram/WhatsApp/iMessage | [Platform Integrations](./03-advanced-usage.md#platform-integrations) |
| Build local-first attention management | [OpenLoomi Architecture](https://github.com/melandlabs/openloomi) |

## Tutorial Contents

| Tutorial | Focus | Key Topics |
|----------|-------|------------|
| [00-getting-started.md](./00-getting-started.md) | Quick Start | Installation, first API call, HTTP server, MCP |
| [01-user-guide.md](./01-user-guide.md) | Core Concepts | Four verbs, temporal graph, IAgent, memory-aware agents |
| [02-developer-guide.md](./02-developer-guide.md) | Integration | Embedding, HTTP server, MCP, backend selection |
| [03-advanced-usage.md](./03-advanced-usage.md) | Advanced Features | Multi-source search, temporal queries, platforms, DSH plugin |
| [04-best-practices.md](./04-best-practices.md) | Production | Idempotency, performance, security, deployment |

## Prerequisites

Before starting any tutorial:

1. **Node.js** >= 18.0.0
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
- 𝕏 Follow [@AlloomiAI](https://x.com/AlloomiAI)

## Contributing

Found an error or want to improve the tutorials? Contributions welcome!

1. Fork the repository
2. Edit the tutorial file
3. Submit a pull request

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines.

---

**Next:** Start with [Getting Started](./00-getting-started.md) or jump to [User Guide](./01-user-guide.md) to learn about memory and agents.
