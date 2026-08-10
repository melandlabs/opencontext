# @openloomi/memory-store

OpenLoomi memory storage + search SDK with optional HTTP and MCP server
entry points. The package is intentionally decoupled from the openloomi
web app's database and env layers — every consumer wires up its own
implementation via `MemoryStoreConfig`.

- **SDK** (`@openloomi/memory-store`) — embed in a Node.js host
- **HTTP** (`@openloomi/memory-store/http`) — REST daemon
- **MCP** (`@openloomi/memory-store/mcp`) — stdio tools for Claude Desktop / Cursor

## Install

```bash
pnpm add @openloomi/memory-store
```

## Quick start

```ts
import { createMemoryStore } from "@openloomi/memory-store";

const store = await createMemoryStore({
  db: { getDb: () => drizzleDb() },
  env: { isTauriMode: () => false },
  unified: {
    embedQuery: async ({ query }) => myEmbed(query),
  },
});

await store.getRawMessageManager();
const hits = await store.searchUnifiedMemory({ userId, query });
```

## Entry points

| Import | What you get |
| --- | --- |
| `@openloomi/memory-store` | `createMemoryStore(config)` facade |
| `@openloomi/memory-store/http` | `startHttpServer(options)` — Hono app on a port |
| `@openloomi/memory-store/mcp` | `startMcpServer()` — stdio MCP server |

CLI bins ship with the package:

```bash
openloomi-memory-http --port 7421 --host 127.0.0.1
openloomi-memory-mcp
```

## Configuration matrix

| Key | Required | Description |
| --- | --- | --- |
| `db.getDb()` | yes for persistence | Drizzle DB handle factory |
| `db.tables.rawMessages` / `db.tables.memorySummaries` | yes for postgres backend | Drizzle table references owned by the host |
| `env.isTauriMode()` | yes | selects sqlite vs postgres backend |
| `env.getTauriDbPath()` / `env.getTauriDataDir()` | for Tauri | where to place the SQLite files |
| `vector.backend` | one of `sqlite-vec` or `chroma` | vector index backend (auto-detected if omitted) |
| `vector.sqliteVec.dbPath` | when backend = sqlite-vec | sqlite-vec DB path |
| `vector.chroma.url` | when backend = chroma | chroma server URL |
| `unified.embedQuery` | yes for unified search | query embedder |
| `unified.searchKnowledge` | optional | RAG over uploaded documents |
| `unified.searchInsights` | optional | semantic search over extracted insights |
| `unified.searchRawMessagesAnn` | optional | postgres-side ANN over `raw_messages` (database fallback) |
| `logger` | optional | `console`-shaped logger; defaults to `console` |

If any of `unified.embedQuery`, `unified.searchKnowledge`, `unified.searchInsights`,
or `unified.searchRawMessagesAnn` are absent, the corresponding source in
`searchUnifiedMemory` returns empty results with a warning. The SDK still
works — fine for a read-only memory daemon or a chroma-only deployment.

See `src/config.ts` for the full type surface.

## Recipes

### 1. Postgres backend (server / agent daemon)

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import {
  createMemoryStore,
  registerPostgresFactory,
  type PostgresRawMessageManagerLike,
} from "@openloomi/memory-store";
import { myPostgresRawMessageManager } from "./postgres-raw-message-store";
import * as schema from "./schema";

registerPostgresFactory<typeof myPostgresRawMessageManager>(
  async () => myPostgresRawMessageManager as unknown as PostgresRawMessageManagerLike,
);

const db = drizzle(process.env.DATABASE_URL!, { schema });

const store = await createMemoryStore({
  db: {
    getDb: () => db,
    tables: {
      rawMessages: schema.rawMessages,
      memorySummaries: schema.memorySummaries,
    },
  },
  env: { isTauriMode: () => false },
  unified: {
    embedQuery: async ({ query }) => myEmbedder.embedQuery(query),
    searchInsights: mySearchInsights,
    searchKnowledge: mySearchKnowledge,
    searchRawMessagesAnn: async ({
      userId, queryEmbedding, limit, threshold, botId,
    }) => myAnnSearch({ userId, queryEmbedding, limit, threshold, botId }),
  },
});
```

### 2. Tauri / SQLite-vec backend (desktop)

```ts
const store = await createMemoryStore({
  env: {
    isTauriMode: () => true,
    getTauriDataDir: () => appDataDir(),
    getTauriDbPath: () => `${appDataDir()}/memory.sqlite`,
  },
  vector: {
    backend: "sqlite-vec",
    sqliteVec: { dbPath: `${appDataDir()}/vectors.sqlite` },
  },
  unified: {
    embedQuery: async ({ query }) => localOnnxEmbedder.embed(query),
  },
});
```

### 3. Chroma backend (managed vector store)

```ts
const store = await createMemoryStore({
  env: { isTauriMode: () => false },
  vector: {
    backend: "chroma",
    chroma: {
      url: process.env.CHROMA_URL ?? "http://127.0.0.1:8000",
      rawMessagesCollection: "openloomi_raw_messages",
      insightsCollection: "openloomi_insights",
    },
  },
  unified: { embedQuery: myEmbedder },
});
```

When chroma is reachable and the host's postgres manager exposes
`searchMessagesSemantically`, chroma wins and the database path becomes
the fallback — same semantics as the web app.

### 4. Cross-source search wiring

`createUnifiedSearch(deps)` accepts the per-source searchers independently.
You don't need to wire all of them; the ones you omit just emit a warning:

```ts
import { createUnifiedSearch } from "@openloomi/memory-store/unified-search";

const search = createUnifiedSearch({
  embedQuery: async ({ userId, query, authToken }) =>
    embedder.embed(query, { userId, authToken }),

  searchRawMessagesAnn: async ({
    userId, queryEmbedding, limit, threshold, botId,
  }) => db.rawMessages.searchAnn({
    userId, embedding: queryEmbedding, limit, threshold, botId,
  }),

  searchInsights: async ({ userId, query, limit, threshold, botIds }) =>
    insightIndex.search({ userId, query, limit, threshold, botIds }),

  searchKnowledge: async ({ userId, query, options, authToken }) =>
    ragIndex.search({ userId, query, ...options, authToken }),
});

const result = await search.searchUnifiedMemory({
  userId: "u-1",
  query: "what changed since yesterday?",
  sources: ["memory", "insights", "knowledge"],
  limit: 10,
  threshold: 0.7,
  botIds: ["bot-42"],
});

// result.results: UnifiedMemorySearchResult[]
// result.warnings: UnifiedMemorySearchWarning[]
//   e.g. { source: "memory", code: "raw_message_storage_unavailable", ... }
```

### 5. Postgres manager factory (lazy registration)

If the host application owns the postgres raw-message manager (e.g. an
existing Drizzle-based repo), register it via the factory pattern. The
memory-store package will resolve it on first use:

```ts
import { registerPostgresFactory } from "@openloomi/memory-store/postgres-raw-message-factory";
import { myPostgresManager } from "./managers/postgres-raw-message";

registerPostgresFactory(async () => myPostgresManager);
// Later — anywhere in the codebase:
import { getRawMessageManager } from "@openloomi/memory-store";
const manager = await getRawMessageManager();
```

If you don't register a factory, the package falls back to the legacy
sqlite path (`env.isTauriMode()` must return true). For non-Tauri hosts,
registering the factory is mandatory.

### 6. HTTP daemon

```ts
import { startHttpServer } from "@openloomi/memory-store/http";

const { url, port, stop } = await startHttpServer({
  port: 7421,
  host: "127.0.0.1",
  // MemoryStoreConfig passthrough:
  env: { isTauriMode: () => false },
  vector: { backend: "chroma", chroma: { url: process.env.CHROMA_URL! } },
  unified: { embedQuery: myEmbedder },
});

console.log(`listening at ${url}`);
// later: await stop();
```

Or run the CLI:

```bash
MEMORY_HTTP_HOST=0.0.0.0 MEMORY_HTTP_PORT=7421 openloomi-memory-http
```

Endpoints:

| Method + path | Body |
| --- | --- |
| `GET  /health` | — |
| `POST /v1/search` | `{ userId, query, limit?, threshold?, sources?, botIds?, documentIds? }` |
| `POST /v1/raw-messages` | `{ userId, messages: RawMessage[] }` |
| `GET  /v1/raw-messages/:id?userId=...` | — |

For container / LAN deployment, put it behind a reverse proxy:

```nginx
location /memory/ {
  proxy_pass         http://127.0.0.1:7421/;
  proxy_set_header   X-Forwarded-User $remote_user;
  proxy_read_timeout 60s;
}
```

### 7. MCP daemon

```bash
openloomi-memory-mcp
```

Tools exposed over stdio:

| Tool | Required args |
| --- | --- |
| `memory.health` | — |
| `memory.searchUnified` | `userId`, `query`, optional `limit`, `threshold`, `sources`, `botIds`, `documentIds` |
| `memory.writeRawMessage` | `userId`, `message: { role, content, platform?, botId?, ... }` |
| `memory.getRawMessage` | `userId`, `messageId` |

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "openloomi-memory": {
      "command": "npx",
      "args": ["-y", "@openloomi/memory-store", "memory-mcp"],
      "env": {
        "DATABASE_URL": "postgres://user:pass@host:5432/openloomi"
      }
    }
  }
}
```

For local dev against this monorepo, point at the built CLI directly:

```json
{
  "mcpServers": {
    "openloomi-memory": {
      "command": "node",
      "args": [
        "/path/to/openloomi/packages/memory-store/dist/server/cli-mcp.js"
      ]
    }
  }
}
```

#### Cursor

Same shape — Cursor reads `mcpServers` from its MCP settings
(Cursor → Settings → MCP → Add new global MCP server):

```json
{
  "mcpServers": {
    "openloomi-memory": {
      "command": "openloomi-memory-mcp"
    }
  }
}
```

After registering, the four `memory.*` tools become available inside the
editor. Tool calls appear in the chat like any other MCP tool.

## Subpath exports

| Subpath | Contents |
| --- | --- |
| `@openloomi/memory-store` | `createMemoryStore`, top-level types |
| `@openloomi/memory-store/http` | `startHttpServer`, `StartedHttpServer` |
| `@openloomi/memory-store/mcp` | `startMcpServer` |
| `@openloomi/memory-store/unified-search` | `createUnifiedSearch(deps)` factory + result types |
| `@openloomi/memory-store/raw-message-store` | `createRawMessageStore`, `getRawMessageManager`, `isRawMessageStorageAvailable` |
| `@openloomi/memory-store/sqlite-raw-message-store` | SQLite-vec raw-message manager (Tauri / desktop) |
| `@openloomi/memory-store/postgres-raw-message-factory` | `registerPostgresFactory`, `resolvePostgresFactory` |
| `@openloomi/memory-store/sqlite-vector-index` | Direct sqlite-vec insight index helpers |
| `@openloomi/memory-store/chroma-memory-index` | Direct chroma upsert / search helpers |
| `@openloomi/memory-store/memory-graph-write-policy` | `resolveMemoryGraphWritePolicy`, allowlist gating |
| `@openloomi/memory-store/memory-graph-correction-policy` | `resolveMemoryGraphCorrectionPolicy` |

## Behaviour notes

- An empty / whitespace `query` short-circuits and returns
  `{ query, sources, results: [], count: 0, warnings: [] }` without
  touching any backend.
- If `isRawMessageStorageAvailable()` returns `false`, the memory source
  emits a `raw_message_storage_unavailable` warning instead of running
  Chroma / postgres search.
- When `botIds` is provided, the memory source fans out across each
  `botId` filter in parallel (`Promise.all(filters.map(...))`) and
  flattens the results. If `botIds` is empty, a single unfiltered query
  is sent.
- `limit` is passed straight through to each underlying backend — no
  silent inflation. `threshold` is clamped to `[-1, 1]`.
- Chroma failures fall back to `unified.searchRawMessagesAnn` when both
  are configured; otherwise the memory source returns empty.

## See also

- [`apps/marketing/content/memory.mdx`](https://github.com/melandlabs/openloomi/blob/main/apps/marketing/content/memory.mdx)
  — end-to-end memory architecture and the standalone-service section.