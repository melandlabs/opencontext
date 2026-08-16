# Real-World Use Cases

These tutorials demonstrate how to combine OpenContext features to build practical, production-ready applications. Each use case shows end-to-end scenarios that integrate multiple concepts.

## Available Use Cases

### 1. [Personal Memory Assistant](./05-personal-memory-assistant.md)

Build an AI assistant that remembers user preferences, stores notes, and shows how thinking evolves over time.

**Features demonstrated:**
- Remembering preferences with metadata
- Storing and searching notes
- Time-travel through personal thoughts
- Updating and improving memories

**Best for:** Personal productivity tools, note-taking apps, memory-aware assistants

**Code example:** `examples/src/tutorials/use-cases/30-personal-memory-assistant.ts`

---

### 2. [Customer Support Agent](./06-customer-support-agent.md)

Create a support bot that remembers customer history, detects repeat issues, and provides personalized service.

**Features demonstrated:**
- Multi-user memory management
- Customer profile and interaction tracking
- Cross-platform memory unification
- Temporal queries for repeat issue detection
- Batch data import

**Best for:** Customer service platforms, helpdesk systems, CRM integrations

**Code example:** `examples/src/tutorials/use-cases/31-customer-support-agent.ts`

---

### 3. [Research Knowledge Tracker](./07-research-tracker.md)

Track academic findings, citations, and how understanding evolves as new research emerges.

**Features demonstrated:**
- Storing findings with rich metadata
- Linking related research via themes
- Time-travel through knowledge states
- Synthesizing multiple findings
- Citation-aware search

**Best for:** Research tools, academic platforms, knowledge management systems

**Code example:** `examples/src/tutorials/use-cases/32-research-knowledge-tracker.ts`

## Running Use Case Examples

Each use case includes a runnable TypeScript example. To run:

```bash
cd /Users/timi/codes/opencontext/examples
pnpm install
node --experimental-strip-types src/tutorials/use-cases/XX-*.ts
```

Replace `XX-*.ts` with the specific example file name.

## Prerequisites

Before working with use cases, complete:
1. [Getting Started](../00-getting-started.md) - Installation and first API call
2. [User Guide](../01-user-guide.md) - Core concepts and the four verbs
3. [Developer Guide](../02-developer-guide.md) - Integration patterns

## Learning Path

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Journey                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 📖 Core Tutorials                                      │
│     → Getting Started, User Guide, Developer Guide          │
│                                                             │
│  2. 🚀 Advanced Topics                                     │
│     → Advanced Usage, Best Practices                       │
│                                                             │
│  3. 🏗️ Real-World Use Cases                               │
│     → Personal Memory Assistant (individual scale)          │
│     → Customer Support Agent (multi-user scale)             │
│     → Research Tracker (knowledge evolution)                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Key Patterns Across Use Cases

### Metadata Strategies

All use cases leverage metadata for advanced filtering:

```typescript
metadata: {
  type: "note|ticket|finding",
  category: "work|login|llm-architecture",
  tags: ["tag1", "tag2"],
  // ... custom fields
}
```

### Temporal Queries

Time-travel is used differently per scenario:

- **Personal Memory**: Track how your thinking changes
- **Support Agent**: Detect repeat issues over time
- **Research**: Show knowledge state at specific points

### Batch Operations

For data import and bulk operations:

```typescript
await messages.storeMessages(largeBatch);
```

## Choosing Your Use Case

| If you're building... | Start with |
|----------------------|------------|
| Personal productivity app | Personal Memory Assistant |
| Customer service tool | Customer Support Agent |
| Research/academic tool | Research Knowledge Tracker |

## Contributing

Have a use case to share? Contributions welcome!

1. Fork the repository
2. Add your use case to `docs/tutorials/use-cases/`
3. Create the matching example in `examples/src/tutorials/use-cases/`
4. Update this README

See [CONTRIBUTING.md](../../../CONTRIBUTING.md) for guidelines.

---

**Next:** Choose a use case above to explore!
