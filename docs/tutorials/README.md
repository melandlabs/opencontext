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
│     Multi-source search, temporal queries, platform integrations       │
│     → 03-advanced-usage.md                                           │
│                                                                       │
│  5. 📚 Best Practices                                                │
│     Production-ready patterns and common pitfalls                     │
│     → 04-best-practices.md                                           │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Quick Reference by Use Case

| You want to... | Read this |
|----------------|------------|
| Get started in 5 minutes | [Getting Started](./00-getting-started.md) |
| Understand how memory works | [User Guide](./01-user-guide.md) |
| Build a memory-aware agent | [User Guide](./01-user-guide.md#building-ai-agents-with-memory) |
| Build a Q&A agent | [User Guide](./01-user-guide.md#agent-patterns) |
| Add Gmail/Slack integrations | [Advanced Usage](./03-advanced-usage.md#platform-integrations) |
| Deploy to production | [Best Practices](./04-best-practices.md) |
| Use with Claude Desktop | [Getting Started](./00-getting-started.md#using-with-claude-desktop-mcp) |
| Run as HTTP service | [Developer Guide](./02-developer-guide.md#pattern-2-http-server-microservice) |
| Create custom agent provider | [User Guide](./01-user-guide.md#creating-a-custom-agent) |

## Tutorial Contents

| Tutorial | Focus | Key Topics |
|----------|-------|------------|
| [00-getting-started.md](./00-getting-started.md) | Quick Start | Installation, first API call, HTTP server, MCP |
| [01-user-guide.md](./01-user-guide.md) | Core Concepts | Four verbs, temporal graph, IAgent, memory-aware agents |
| [02-developer-guide.md](./02-developer-guide.md) | Integration | Embedding, HTTP server, MCP, backend selection |
| [03-advanced-usage.md](./03-advanced-usage.md) | Advanced Features | Multi-source search, temporal queries, platforms |
| [04-best-practices.md](./04-best-practices.md) | Production | Idempotency, performance, security, deployment |

## Prerequisites

Before starting any tutorial:

1. **Node.js** >= 18.0.0
2. **pnpm** >= 9.0.0 (recommended) or npm/yarn

Verify:

```bash
node --version  # Should be >= 18.0.0
pnpm --version  # Should be >= 9.0.0
```

## Platform-Specific Prerequisites

**Windows:** Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) with C++ components

**macOS:** `xcode-select --install`

**Linux:** `sudo apt-get install build-essential`

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

- 📖 Check the main [README](../README.md)
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
