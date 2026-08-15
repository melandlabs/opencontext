# Getting Started with OpenContext

Welcome! This guide will help you get up and running with OpenContext in 5 minutes.

## What is OpenContext?

OpenContext is the **agentic context runtime** that powers applications that act on your behalf. It provides:

- **Temporal memory** - facts are stored with `valid_from` / `valid_until` for time-travel queries
- **Unified search** - search across memory, insights, and knowledge in one call
- **27+ platform integrations** - Gmail, Slack, Telegram, Linear, Jira, and more
- **Deterministic loop engine** - schedule when your agent should wake up
- **Library-first API** - one npm package, no framework required

## Prerequisites

Before you begin, ensure you have:

- **Node.js** >= 18.0.0
- **pnpm** >= 9.0.0 (recommended) or npm/yarn

Verify your installation:

```bash
node --version  # Should be >= 18.0.0
pnpm --version  # Should be >= 9.0.0
```

## Installation

### Option 1: Install as a library (most common)

Create a new project and install OpenContext:

```bash
# Create a new project
mkdir my-agent-app
cd my-agent-app
pnpm init

# Install OpenContext
pnpm add @melandlabs/opencontext
```

### Option 2: Build from source

If you want to contribute or explore the source:

```bash
git clone https://github.com/melandlabs/opencontext.git
cd opencontext
pnpm install
pnpm -r build
```

## Your First Memory API Call

Create a file `hello-memory.ts`:

```typescript
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  // Create the memory store (uses SQLite by default)
  const store = await createMemoryStore();
  const messages = await getRawMessageManager();

  const now = Date.now();

  // Store a fact about the user
  await messages.storeMessages([
    {
      messageId: "msg-1",
      userId: "user-42",
      content: "User prefers dark mode in all applications",
      platform: "tutorial",
      botId: "tutorial-bot",
      timestamp: now,
      createdAt: now,
    },
  ]);

  console.log("✅ Memory stored!");

  // Search for what we just stored
  const results = await store.searchUnifiedMemory({
    userId: "user-42",
    query: "What does the user prefer?",
    limit: 5,
  });

  console.log("🔍 Search results:", results);
  console.log(`Found ${results.count} results`);
  console.log(`Warnings: ${results.warnings.length}`);
}

main().catch(console.error);
```

Run it:

```bash
# If using tsx or ts-node
npx tsx hello-memory.ts

# Or with Node.js 22+ (supports --experimental-strip-types)
node --experimental-strip-types hello-memory.ts
```

## Using the HTTP Server

OpenContext can run as a standalone HTTP server:

```bash
# Start the server with local embeddings and SQLite
opencontext http \
  --embedding-provider local \
  --memory-backend sqlite-vec \
  --host 127.0.0.1 \
  --port 7421
```

Test it:

```bash
# Health check
curl http://127.0.0.1:7421/health

# Store a message
curl -X POST http://127.0.0.1:7421/v1/raw-messages \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-42",
    "embedOnInsert": true,
    "messages": [{
      "role": "user",
      "messageId": "http-msg-1",
      "content": "User prefers dark mode",
      "platform": "test",
      "botId": "test-bot",
      "timestamp": 1700000000000,
      "createdAt": 1700000000000
    }]
  }'

# Search memory
curl -X POST http://127.0.0.1:7421/v1/search \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-42",
    "query": "What does the user prefer?",
    "limit": 5
  }'
```

## Using with Claude Desktop (MCP)

OpenContext ships an MCP server for Claude Desktop and Cursor:

1. Open your Claude Desktop config:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%/Claude/claude_desktop_config.json`

2. Add the MCP server:

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
        "--memory-backend", "sqlite-vec"
      ]
    }
  }
}
```

3. Restart Claude Desktop

You now have access to four tools inside Claude:
- `memory.health` - Check if OpenContext is running
- `memory.searchUnified` - Search memory with a query
- `memory.writeRawMessage` - Store new messages
- `memory.getRawMessage` - Retrieve a specific message

## Diagnosing Your Installation

OpenContext includes a `doctor` command for health checks:

```bash
# Human-readable report
opencontext doctor

# JSON output for CI/CD
opencontext doctor --json

# Check a specific section
opencontext doctor --section memory-store

# Deep probe (includes real memory-store read)
opencontext doctor --deep
```

The doctor checks nine sections:
- `runtime` - Node.js version and platform
- `filesystem` - Write permissions and directory structure
- `loop` - Loop engine configuration
- `memory-store` - Database connectivity
- `embedding` - Embedding provider availability
- `policies` - Security policy configuration
- `audit` - Audit logging setup
- `security` - Encryption and URL validation
- `integrations` - Platform integration credentials

## Next Steps

Now that you have OpenContext running:

1. 📖 Read the [User Guide](./01-user-guide.md) to learn the core concepts
2. 🔧 Check the [Developer Guide](./02-developer-guide.md) for integration patterns
3. 🚀 Explore [Advanced Usage](./03-advanced-usage.md) for production recipes
4. 📚 See [Best Practices](./04-best-practices.md) for tips from the team

## Troubleshooting

### "Cannot find module '@melandlabs/opencontext'"

Make sure you've installed the package:

```bash
pnpm add @melandlabs/opencontext
```

### "better-sqlite3 failed to build"

On some systems, the native `better-sqlite3` module may need build tools:

**macOS:**
```bash
xcode-select --install
```

**Ubuntu/Debian:**
```bash
sudo apt-get install build-essential
```

**Windows:**
Install [Windows Build Tools](https://github.com/felixrieseberg/windows-build-tools):

```bash
npm install --global windows-build-tools
```

### "Embedding provider not configured"

Use the `--embedding-provider` flag or set the `EMBEDDING_PROVIDER` environment variable:

```bash
opencontext http --embedding-provider local
```

## Getting Help

- 📖 [Documentation](../README.md)
- 💬 [Discord](https://discord.com/invite/xkJaJyWcsv)
- 🐛 [Issues](https://github.com/melandlabs/opencontext/issues)
- 𝕏 [@AlloomiAI](https://x.com/AlloomiAI)

---

**Sources:**
- [Write the Docs - Getting Started Guide](https://www.writethedocs.org/guide/starting/)
- [GitHub Blog - Documentation Done Right](https://github.blog/developer-skills/documentation-done-right-a-developers-guide/)
- [ClickHelp - Best Practices for Developer Documentation](https://clickhelp.com/clickhelp-technical-writing-blog/best-practices-for-creating-developer-documentation/)
