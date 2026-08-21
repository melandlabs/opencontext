# Getting Started with OpenContext

Welcome! This guide will help you get up and running with OpenContext in 5 minutes.

## What is OpenContext?

OpenContext is the **agentic context runtime** that powers applications that act on your behalf. It provides:

- **Temporal memory** - facts are stored with `valid_from` / `valid_until` for time-travel queries
- **Unified search** - search across memory, insights, and knowledge in one call
- **Multi-platform integrations** - Gmail, Slack, Telegram, Linear, Jira, and more
- **Deterministic loop engine** - schedule when your agent should wake up
- **Library-first API** - one npm package, no framework required

## Prerequisites

Before you begin, ensure you have:

- **Node.js** >= 22
- **pnpm** >= 9 (recommended) or npm/yarn

Verify your installation:

```bash
node --version  # Should be >= 22
pnpm --version  # Should be >= 9
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

> **Note:** OpenContext includes `@melandlabs/ai-rag` as a dependency, which will be installed automatically. This package provides local embeddings support.

> **Important: Native modules (better-sqlite3)**

OpenContext uses `better-sqlite3`, a native module that requires compilation. With pnpm, you need to approve build scripts:

```bash
# After installation, approve build scripts for native modules
pnpm approve-builds better-sqlite3

# Then reinstall to trigger the build
pnpm install
```

If you skip this step, you'll see "Could not locate the bindings file" error when running your code.

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
  // Use a unique message ID to avoid conflicts when running multiple times
  const messageId = `msg-${now}`;

  // Store a fact about the user
  await messages.storeMessages([
    {
      messageId,
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
  const results = await store.search({
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

# Or with Node.js 22+ (supports --experimental-strip-types for running TypeScript directly)
node --experimental-strip-types hello-memory.ts
```

> **About the warnings:** You'll see a warning about `memory_lexical_search_fallback`. This is expected - by default, OpenContext uses keyword search (no API keys required).

## SDK Mode: With Local Embeddings

For semantic search in SDK mode, configure a local embedding provider:

```typescript
import { createMemoryStore, getRawMessageManager, LocalTransformersEmbeddingProvider } from "@melandlabs/opencontext";

async function main() {
  const embeddingProvider = new LocalTransformersEmbeddingProvider({
    modelName: "Xenova/all-MiniLM-L6-v2",
  });

  const store = await createMemoryStore({
    unified: {
      embedQuery: async ({ query }) => {
        return await embeddingProvider.embedQuery(query);
      },
    },
  });

  const messages = await getRawMessageManager();
  const now = Date.now();

  // Store with pre-computed embedding
  const embedding = await embeddingProvider.embedQuery("User prefers dark mode");

  await messages.storeMessages([{
    messageId: `msg-${now}`,
    userId: "user-42",
    content: "User prefers dark mode in all applications",
    platform: "tutorial",
    botId: "tutorial-bot",
    timestamp: now,
    createdAt: now,
    embedding,
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
  }]);

  // Semantic search
  const results = await store.search({
    userId: "user-42",
    query: "What theme does the user like?",
    limit: 5,
  });

  console.log("Found", results.count, "results");
}

main().catch(console.error);
```

> **Note:** SDK mode requires manual embedding handling. For automatic embeddings with better results, use the HTTP server below.

## Managing Memory from the CLI

Beyond the SDK, the same memory store is reachable from the command line
with two verbs: `add` writes a single raw message straight to the active
manager — no LLM roundtrip, no `consolidate()` loop — and `search` runs a
unified read across memory, insights, and knowledge. CLI is the lightest
entry point: no daemon, no HTTP client, just `npx …` or a globally
installed `opencontext`.

### `opencontext add` — write one fact

`add` is the CLI equivalent of `messages.storeMessages(...)`. It bypasses
the agentic `consolidate()` loop, so it's fast and deterministic — useful
for CLI backfills, scripted ingestion, and ad-hoc captures that you intend
to let `consolidate` pick up later.

Auto-filled when omitted:

| Field      | Default                  |
| ---------- | ------------------------ |
| `userId`   | `"default"`              |
| `botId`    | `"default"`              |
| `platform` | `"cli"`                  |
| `timestamp`| `Date.now()`             |
| `messageId`| `crypto.randomUUID()`    |
| `createdAt`| `Date.now()`             |

**Flag reference:**

| Flag                        | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `--text <text>` *(required)*| Message content                                                        |
| `--user <id>`               | User / workspace id                                                    |
| `--bot <id>`                | Bot id                                                                 |
| `--platform <name>`         | Origin platform tag (e.g. `"slack"`, `"telegram"`)                     |
| `--channel <name>`          | Channel label                                                          |
| `--person <id>`             | Author / sender id                                                     |
| `--source <uri>`            | Stored in `metadata.source`                                            |
| `--kind <factType>`         | Kind tag, written to the top-level `factType` field. The closed set `world \| experience \| mental_model` is what `search --kind` recognises; anything else is accepted but will produce zero hits from the filter |
| `--at <iso-8601>`           | Timestamp override                                                     |
| `--tag <key=value>`         | Free-form tag, repeatable (also `--tag=k=v`)                           |
| `--json`                    | Emit JSON envelope `{ ok, exit, count, ids, platform }` instead of the default human line. `ids[]` are numeric DB row IDs, not the UUID `messageId` |

**Exit codes:** `0` on success, `1` on validation error or backend refusal.

**Examples:**

```bash
# Minimal
opencontext add --user alice --text "Rust achieves memory safety without GC"

# Full provenance for later consolidation
opencontext add \
  --user alice --bot general \
  --text "Discussed Q4 roadmap with the team" \
  --source "meeting://2026-08-20" --kind experience \
  --tag topic=roadmap --tag team=eng

# Script-friendly
opencontext add --user alice --text "..." --json
```

### `opencontext search` — read across memory + insights + knowledge

`search` is the CLI equivalent of `store.search(...)`, with three flavours
picked by `--mode` and one escape hatch (`--context-only`) that surfaces the
exact prompt context that would have been sent to the LLM — without paying
for a synthesis call.

**Flag reference:**

| Flag                          | Purpose                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `--query <text>` / `-q` *(required)* | Search query                                                                                     |
| `--user <id>`                 | User / workspace id (default `"default"`)                                                              |
| `--mode <name>`               | `auto` (default, RRF hybrid) / `lex` (similarity, default sources) / `sem` (similarity, memory only)    |
| `--k <int>` / `--limit`       | Top-k (default `10`)                                                                                   |
| `--threshold <float>`         | Similarity threshold in `[0, 1]`                                                                       |
| `--bot <id>`                  | Filter to one bot, repeatable                                                                          |
| `--kind <factType>`           | Filter on `factTypes` (maps to DB `fact_type` column), repeatable. `add --kind` writes to the same column, so the two flags are symmetric |
| `--since <iso-8601>`          | Inclusive start date for memory timestamps                                                             |
| `--until <iso-8601>`          | Inclusive end date for memory timestamps                                                               |
| `--json`                      | Emit full `SearchOutput` as JSON                                                                       |
| `--context-only`              | Print the prompt context that would have been sent to the LLM (no synthesis call)                      |
| `--explain`                   | In human output, also print the `warnings[]` block. `reasoning` is not surfaced by this CLI — `synthesize` is hardcoded to `false` so no LLM synthesis runs |

**Exit codes:** `0` on completion (zero hits is still success), `1` on
validation error or backend failure.

**Examples:**

```bash
# Plain hybrid search across all sources
opencontext search --user alice --query "memory safety" --k 5

# Lex-only, top 5
opencontext search --user alice --query "memory safety" --mode lex --k 5

# Date-scoped
opencontext search --user alice --query "Q4 roadmap" \
  --since 2026-08-01 --until 2026-08-31 --k 20

# Debug: see what the LLM would have received, no model call
opencontext search --user alice --query "what did we chat about last weekend" --context-only

# Script-friendly
opencontext search --user alice --query "x" --json | jq '.results[].id'
```

> **Tip:** `--mode auto` runs the same hybrid pipeline the HTTP
> `/v1/search` endpoint uses (RRF across memory + insights + knowledge).
> Use `--mode sem` when you want only the memory source, or `--mode lex`
> to skip hybrid ranking and rely on similarity scoring alone.

Run `opencontext <command> --help` for the full, up-to-date flag list.

## Using the HTTP Server

OpenContext can run as a standalone HTTP server with local embeddings:

```bash
# Start the server with local embeddings (no API keys needed)
npx @melandlabs/opencontext http \
  --embedding-provider local \
  --memory-backend sqlite-vec \
  --host 127.0.0.1 \
  --port 7421
```

> **Tip:** For frequent use, install globally: `pnpm add -g @melandlabs/opencontext`, then use `opencontext http` directly.

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

## Using with Your Coding Agent via MCP

OpenContext ships an MCP server that works with any MCP-compatible coding agent, including:

- **Cursor** - AI code editor
- **Claude Code** - Anthropic's CLI coding agent
- **Codex CLI** - Command-line agent runtime
- And any other MCP-compatible coding agent

### Setting up MCP

1. Open your agent's MCP configuration:
   - **Cursor**: Settings → MCP Servers
   - **Claude Code**: See its MCP configuration documentation
   - **Codex CLI**: See its MCP server documentation
   - **Other coding agents**: Refer to their MCP documentation

2. Add the OpenContext MCP server configuration:

**For coding agent integration:**
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

**For Cursor:**
Use the same configuration above via Settings → MCP Servers.

**For Codex CLI:**
See Codex's MCP server configuration documentation.

3. Restart your agent application

You now have access to four memory tools:
- `memory.health` - Check if OpenContext is running
- `memory.search` - Search memory with a query (set `synthesize: true` for LLM-synthesized answers)
- `memory.writeRawMessage` - Store new messages
- `memory.getRawMessage` - Retrieve a specific message

## Diagnosing Your Installation

OpenContext includes a `doctor` command for health checks:

```bash
# Human-readable report
npx @melandlabs/opencontext doctor

# JSON output for CI/CD
npx @melandlabs/opencontext doctor --json

# Check a specific section
npx @melandlabs/opencontext doctor --section memory-store

# Deep probe (includes real memory-store read)
npx @melandlabs/opencontext doctor --deep
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

### "Cannot find module '@melandlabs/ai-rag/...'"

This was fixed in v0.2.1. If you're using v0.2.0, either:

1. Update to the latest version:
```bash
pnpm update @melandlabs/opencontext
```

2. Or manually install the missing dependency:
```bash
pnpm add @melandlabs/ai-rag
```

### "better-sqlite3 failed to build" or "Could not locate the bindings file"

`better-sqlite3` is a native module that must be built for your system. With pnpm, build scripts are ignored by default for security.

**Solution 1: Approve build scripts (recommended)**

```bash
# This will show an interactive prompt - press Space to select better-sqlite3, then Enter
pnpm approve-builds

# Reinstall to trigger the build
pnpm install
```

**Solution 2: Use node_modules symlink bypass**

```bash
# Build directly in the package directory
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
npm run build
cd ../../../../../..
```

**Solution 3: Configure pnpm to always trust this package**

Add to your root `.npmrc` or `package.json`:

```bash
# .npmrc
public-hoist-pattern[]=@melandlabs/opencontext
public-hoist-pattern[]=better-sqlite3
```

Then run:
```bash
pnpm install
```

**If you don't have build tools installed**, you may need to install them first:

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
npx @melandlabs/opencontext http --embedding-provider local
```

## Getting Help

- 📖 [Documentation Index](../README.md)
- 💬 [Discord](https://discord.com/invite/xkJaJyWcsv)
- 🐛 [Issues](https://github.com/melandlabs/opencontext/issues)
- 𝕏 [@OpenContextAI](https://x.com/OpenContextAI)

## Glossary

| Term | Description |
|------|-------------|
| `RawMessage` | The basic unit of data stored in OpenContext - a message with content, metadata, and timestamps |
| `Temporal context graph` | A directed graph where each fact has `valid_from` and `valid_until` timestamps, enabling time-travel queries |
| `Memory-aware agent` | An AI agent that can recall and use context from past interactions |
| `Embedding` | A vector representation of text that enables semantic search |
| `MCP` | Model Context Protocol - a standard for AI agents to access external tools and data |
| `SSRF` | Server-Side Request Forgery - a security vulnerability that OpenContext protects against via URL validation |

---

**Sources:**
- [Write the Docs - Getting Started Guide](https://www.writethedocs.org/guide/starting/)
- [GitHub Blog - Documentation Done Right](https://github.blog/developer-skills/documentation-done-right-a-developers-guide/)
- [ClickHelp - Best Practices for Developer Documentation](https://clickhelp.com/clickhelp-technical-writing-blog/best-practices-for-creating-developer-documentation/)
