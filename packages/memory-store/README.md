# memory-store (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

OpenContext memory storage + search SDK with optional HTTP and MCP server
entry points. The package is intentionally decoupled from the opencontext
web app's database layer — every consumer wires up its own backend via
the `db` contract on `MemoryStoreConfig`.

- **SDK** (`memory-store`) — embed in a Node.js host
- **HTTP** (`memory-store/http`) — REST daemon
- **MCP** (`memory-store/mcp`) — stdio tools for Claude Desktop / Cursor

## Install

```bash
pnpm add @melandlabs/opencontext
```

## Quick start

```ts
import { createMemoryStore } from "@melandlabs/opencontext";

const store = await createMemoryStore({
	// Required for the postgres backend (OPENCONTEXT_MEMORY_STORE_BACKEND=postgres).
	// For the default sqlite backend, omit db and the SDK writes to
	// ~/.opencontext/memory/store.db (override with MEMORY_STORE_DB_PATH).
	db: { getDb: () => drizzleDb() },
	unified: {
		embedQuery: async ({ query }) => myEmbed(query),
	},
});

const hits = await store.search({ userId, query });
```

## Capabilities

The store exposes the four-verb memory API plus two read/write reflection
endpoints:

| Capability | SDK method | HTTP | MCP tool |
|---|---|---|---|
| Read-only search across all sources | `store.search(input)` | `POST /v1/search` | `memory.search` |
| Read a single `RawMessage` | `manager.getMessageById(id)` | `GET /v1/raw-messages/:id?userId=…` | `memory.getRawMessage` |
| Persist a `RawMessage` | `manager.storeMessages([…])` | `POST /v1/raw-messages` | `memory.writeRawMessage` |
| Read-only LLM synthesis over evidence | `store.search({ ...input, synthesize: true })` | `POST /v1/search` (set `synthesize: true`) | `memory.search` (set `synthesize: true`) |
| LLM reasoning layer (query-rewrite / iterative planner) | `store.search({ ...input, reasoningStrategy: "rewrite" \| "iterative" })` | `POST /v1/search` (set `reasoningStrategy`) | `memory.search` (set `reasoningStrategy`) |
| **Agentic write-back** (gather → plan → vet → persist) | `store.consolidate(input)` | `POST /v1/consolidate:apply` | `memory.consolidate` |
| Health probe | — | `GET /health` | `memory.health` |

## Entry points

| Import              | What you get                                    |
| ------------------- | ----------------------------------------------- |
| `memory-store`      | `createMemoryStore(config)` facade              |
| `memory-store/http` | `startHttpServer(options)` — Hono app on a port |
| `memory-store/mcp`  | `startMcpServer()` — stdio MCP server           |

CLI bins ship with the package:

```bash
opencontext-memory-http --port 7421 --host 127.0.0.1
opencontext-memory-mcp
```

Both bins accept the same `--embedding-provider` / `--*-backend` flag surface
(see `--help` for the full list). Reasoning is **off by default** — opt in
with `--reasoning`, which reads `OPENCONTEXT_LLM_API_KEY` /
`OPENCONTEXT_LLM_BASE_URL` / `OPENCONTEXT_LLM_MODEL` from the environment:

```bash
# HTTP daemon with local embeddings + sqlite-vec memory + LLM reasoning
opencontext-memory-http \
  --reasoning \
  --embedding-provider local \
  --memory-backend sqlite-vec

# Same wiring, stdio MCP daemon (Claude Desktop / Cursor / Claude Code)
opencontext-memory-mcp \
  --reasoning \
  --embedding-provider local \
  --memory-backend sqlite-vec
```

Once the daemon is up, `POST /v1/search` (HTTP) and `memory.search` (MCP)
honor a `reasoningStrategy` field:

| `reasoningStrategy` | What runs |
|---|---|
| `"none"` (default) | Plain hybrid search — no LLM call. |
| `"rewrite"`         | One LLM call rephrases the query into a first-person memory-check question, then the normal hybrid search runs. |
| `"iterative"`       | An LLM planner searches, notes evidence, searches again — multi-hop / temporal questions benefit most. |

The response carries a `reasoning` block (`{ strategy, iterations,
evidenceCount, degraded }`) so callers can observe what ran. See
[Recipe 9](#9-http-daemon) and [Recipe 10](#10-mcp-daemon) below for the
programmatic equivalents.

## Configuration matrix

| Key                                                   | Required                        | Description                                               |
| ----------------------------------------------------- | ------------------------------- | --------------------------------------------------------- |
| `db.getDb()`                                          | yes for postgres backend        | Drizzle DB handle factory                                 |
| `db.tables.rawMessages` / `db.tables.memorySummaries` | when using postgres backend     | Drizzle table references owned by the host                |
| `dbPath`                                              | optional                        | SQLite path override (also reads `MEMORY_STORE_DB_PATH`)  |
| `vector.backend`                                      | one of `sqlite-vec` or `chroma` | vector index backend (auto-detected if omitted)           |
| `vector.sqliteVec.dbPath`                             | when backend = sqlite-vec       | sqlite-vec DB path                                        |
| `vector.chroma.url`                                   | when backend = chroma           | chroma server URL                                         |
| `unified.embedQuery`                                  | yes for unified search          | query embedder                                            |
| `unified.searchKnowledge`                             | optional                        | RAG over uploaded documents                               |
| `unified.searchInsights`                              | optional                        | semantic search over extracted insights                   |
| `unified.searchRawMessagesAnn`                        | optional                        | postgres-side ANN over `raw_messages` (database fallback) |
| `unified.searchRawMessagesLexical`                    | optional                        | BM25/FTS5 fallback when lexical search is enabled         |
| `unified.searchSummaries`                              | optional                        | L1/L2/L3 summary recall (used by `reflect`)               |
| `unified.peerScopeCheck`                              | optional                        | host check that gates `peerFilter` narrowing              |
| `unified.reranker`                                    | optional                        | cross-encoder / learned ranker applied after merge        |
| `unified.reasoning.queryRewriter`                     | optional, enables `"rewrite"`   | turns third-person questions into first-person memory checks before embedding |
| `unified.reasoning.iterativePlanner`                  | optional, enables `"iterative"` | LLM-driven multi-step recall; planner calls back into `search` and `note` actions |
| `unified.reasoning.complete`                          | optional, enables `synthesize`  | single-turn LLM callback for evidence synthesis (`reflect`) |
| `unified.reasoning.defaultStrategy`                   | optional                        | `"none" \| "rewrite" \| "iterative"` — applied when callers omit `reasoningStrategy` |
| `graphStore`                                          | optional                        | `MemoryGraphStoreWithOperationHistory`; powers `consolidate` |
| `storage`                                             | optional                        | `MemoryStorageAdapter` for `deprecateRecords` writes      |
| `logger`                                              | optional                        | `console`-shaped logger; defaults to `console`            |

Backend selection is **env-var driven, not host-injected**: the default is
SQLite at `~/.opencontext/memory/store.db`; set
`OPENCONTEXT_MEMORY_STORE_BACKEND=postgres` to opt into the host's
registered Postgres factory (call `registerPostgresFactory` at startup).

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
} from "@melandlabs/memory-store";
import { myPostgresRawMessageManager } from "./postgres-raw-message-store";
import * as schema from "./schema";

registerPostgresFactory<typeof myPostgresRawMessageManager>(
	async () =>
		myPostgresRawMessageManager as unknown as PostgresRawMessageManagerLike,
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
	unified: {
		embedQuery: async ({ query }) => myEmbedder.embedQuery(query),
		searchInsights: mySearchInsights,
		searchKnowledge: mySearchKnowledge,
		searchRawMessagesAnn: async ({
			userId,
			queryEmbedding,
			limit,
			threshold,
			botId,
		}) => myAnnSearch({ userId, queryEmbedding, limit, threshold, botId }),
	},
});
```

### 2. SQLite-vec backend (desktop / local)

```ts
const store = await createMemoryStore({
	dbPath: `${appDataDir()}/memory.sqlite`,
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
	vector: {
		backend: "chroma",
		chroma: {
			url: process.env.CHROMA_URL ?? "http://127.0.0.1:8000",
			rawMessagesCollection: "opencontext_raw_messages",
			insightsCollection: "opencontext_insights",
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
import { createUnifiedSearch } from "@melandlabs/memory-store/unified-search";

const search = createUnifiedSearch({
	embedQuery: async ({ userId, query, authToken }) =>
		embedder.embed(query, { userId, authToken }),

	searchRawMessagesAnn: async ({
		userId,
		queryEmbedding,
		limit,
		threshold,
		botId,
	}) =>
		db.rawMessages.searchAnn({
			userId,
			embedding: queryEmbedding,
			limit,
			threshold,
			botId,
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

### 5. FactType filter

Atomic facts are classified as `world` (facts about the world), `experience`
(first-person events), or `mental_model` (generalised patterns). The
`FactType` union lives in `@melandlabs/ai/memory/contracts`; the
`rawMessageToMemoryRecord` adapter (in both `indexeddb` and `memory-store`)
carries it through.

```ts
// Write side — set factType on each RawMessage.
await manager.storeMessages([
	{
		messageId: "f-1",
		userId: "u-42",
		content: "water boils at 100°C at sea level",
		platform: "tutorial",
		botId: "tutorial-bot",
		timestamp: Date.now(),
		factType: "world",
	},
	{
		messageId: "f-2",
		userId: "u-42",
		content: "I went hiking last weekend",
		platform: "tutorial",
		botId: "tutorial-bot",
		timestamp: Date.now(),
		factType: "experience",
	},
]);

// Read side — filter by factType.
const hits = await store.search({
	userId: "u-42",
	query: "what did I do recently?",
	factTypes: ["experience"],
	limit: 5,
});
```

Schema migration: IndexedDB `DB_VERSION` 3 → 4 (additive `factType` index on
`raw_messages`), SQLite `RAW_MESSAGES_SCHEMA_VERSION` 3 → 4 (additive
`fact_type` column + partial index). Both migrations are idempotent and
tolerate v3 rows whose `factType` is undefined.

### 6. Read-only `search({ synthesize: true })` — LLM synthesis

`store.search({ ...input, synthesize: true })` is the read-only sibling of
the write-back loop. It fans out across raw messages, summaries,
insights, and knowledge chunks, then asks the LLM to produce a single
synthesised answer. No writes.

```ts
const out = await store.search({
	userId: "u-42",
	query: "what does the user like to do on weekends?",
	tiers: ["summary", "raw", "insight", "knowledge"],
	limit: 20,
	threshold: 0.7,
	synthesize: true,
});

console.log(out.answer);          // LLM synthesis
console.log(out.evidence);        // the bracket-cited evidence items
console.log(out.warnings);        // structured warnings, never throws
```

The LLM is wired via `unified.reasoning.complete` — the same hook used by
the search-rewrite and iterative-recall strategies. When no LLM is wired,
`reflect()` returns the gathered evidence with a
`reflect_llm_not_configured` warning instead of throwing.

### 7. Agentic write-back `consolidate()` — gather → plan → vet → persist

`store.consolidate()` is the agentic counterpart. It runs the same
evidence pipeline as `reflect()`, then:

1. Builds a `MemoryConsolidationPlan` from the evidence (rule-based; the
   LLM is not free to invent `MemoryGraphOperation`s).
2. **Optionally** asks the LLM (`reasoning.complete`) to approve or veto
   plan entries. The LLM never adds new entries — it only marks existing
   ones as `approve` or `veto` with a reason.
3. Persists via `MemoryGraphStore.persistPlan` (when `graphStore` is wired)
   and always runs `storage.deprecateRecords` for `deprecate` entries.

```ts
import { createMemoryStore, attachMemoryGraphStore } from "@melandlabs/memory-store";

// 1. Wire the graph store (opt-in).
attachMemoryGraphStore(store, {
	storage: myIndexedDbStorage,
	ownerScope: { userId: "u-42" },
});

// 2. Inspect the plan first (dry-run).
const dry = await store.consolidate({
	userId: "u-42",
	query: "summarise the last week",
	ownerScope: { userId: "u-42" },
	tiers: ["raw", "summary"],
	dryRun: true,
});
console.log(dry.plan);             // MemoryConsolidationPlan
console.log(dry.applied);          // false

// 3. Apply for real.
const result = await store.consolidate({
	userId: "u-42",
	query: "summarise the last week",
	ownerScope: { userId: "u-42" },
	tiers: ["raw", "summary"],
	dryRun: false,
});
console.log(result.applied);               // true
console.log(result.persistenceResult);     // { applied, skipped, conflicts }
console.log(result.deprecationCounts);     // [{ supersededBySummaryId, count }]
```

Failure modes are typed:
- `reflect_apply_llm_skipped` — no LLM configured; the rule-based plan runs.
- `reflect_apply_llm_vet_failed` — LLM threw; approve-all fallback.
- `reflect_apply_graph_store_not_configured` — `deprecateRecords` still runs.
- `reflect_apply_dry_run` — `dryRun: true`; nothing was written.
- `reflect_apply_no_writes` — plan contains no actionable entries.

### 8. Postgres manager factory (lazy registration)

If the host application owns the postgres raw-message manager (e.g. an
existing Drizzle-based repo), register it via the factory pattern. The
memory-store package will resolve it on first use:

```ts
import { registerPostgresFactory } from "@melandlabs/memory-store/postgres-raw-message-factory";
import { myPostgresManager } from "./managers/postgres-raw-message";

registerPostgresFactory(async () => myPostgresManager);
// Later — anywhere in the codebase:
import { getRawMessageManager } from "@melandlabs/memory-store";
const manager = await getRawMessageManager();
```

If you don't register a factory, the default SQLite backend (`dbPath` or
`~/.opencontext/memory/store.db`) is used. For server-side hosts that
want Postgres, registering the factory is mandatory.

### 9. HTTP daemon

```ts
import { startHttpServer } from "@melandlabs/memory-store/http";

const { url, port, stop } = await startHttpServer({
	port: 7421,
	host: "127.0.0.1",
	// MemoryStoreConfig passthrough:
	vector: { backend: "chroma", chroma: { url: process.env.CHROMA_URL! } },
	unified: { embedQuery: myEmbedder },
});

console.log(`listening at ${url}`);
// later: await stop();
```

Or run the CLI:

```bash
MEMORY_HTTP_HOST=0.0.0.0 MEMORY_HTTP_PORT=7421 opencontext-memory-http
```

To opt into LLM reasoning from the CLI, add `--reasoning`. The bin reads
`OPENCONTEXT_LLM_API_KEY` / `OPENCONTEXT_LLM_BASE_URL` / `OPENCONTEXT_LLM_MODEL`
from the environment — your existing `.env` works as-is:

```bash
OPENCONTEXT_LLM_API_KEY=sk-... \
  opencontext-memory-http \
    --reasoning \
    --embedding-provider local \
    --memory-backend sqlite-vec
```

Programmatically, wire the reasoning layer via `unified.reasoning`:

```ts
import { startHttpServer } from "@melandlabs/memory-store/http";
import {
	createUserVoiceRewriter,
	createIterativeRecallPlanner,
} from "@melandlabs/memory-store";

const complete = async (prompt: string) => callMyLlm(prompt); // any OpenAI-compatible chat completions endpoint

const { url, stop } = await startHttpServer({
	port: 7421,
	host: "127.0.0.1",
	unified: {
		embedQuery: myEmbedder,
		reasoning: {
			queryRewriter: createUserVoiceRewriter({ complete }),
			iterativePlanner: createIterativeRecallPlanner({ complete }),
			// defaultStrategy: "iterative",  // uncomment to enable by default
		},
	},
});
```

Endpoints:

| Method + path                          | Body                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET  /health`                         | —                                                                                                   |
| `POST /v1/search`                      | `{ userId, query, limit?, threshold?, sources?, botIds?, documentIds?, factTypes?, synthesize?, reasoningStrategy? }` |
| `POST /v1/consolidate:apply`           | `{ userId, query, ownerScope, tiers?, limit?, threshold?, dryRun?, expectedVersion?, llmPlanReview? }` |
| `POST /v1/raw-messages`                | `{ userId, messages: RawMessage[] }`                                                                |
| `GET  /v1/raw-messages/:id?userId=...` | —                                                                                                   |

`reasoningStrategy` accepts `"none"` (default — no LLM call),
`"rewrite"` (single LLM rephrase), or `"iterative"` (multi-step planner).
When set and the server is not wired with the corresponding provider, the
response includes a `*_not_configured` warning and the search falls back to
the default path.

For container / LAN deployment, put it behind a reverse proxy:

```nginx
location /memory/ {
  proxy_pass         http://127.0.0.1:7421/;
  proxy_set_header   X-Forwarded-User $remote_user;
  proxy_read_timeout 60s;
}
```

### 10. MCP daemon

```bash
opencontext-memory-mcp
```

**Wire format on stdio: NDJSON.** Each line is a single JSON-RPC object —
the request, the response, or a notification. The server writes
`JSON.stringify(message) + '\n'` and reads by `indexOf('\n')`. This is the
default set by `@modelcontextprotocol/sdk@^1.25.3`'s `StdioServerTransport`.
Most official MCP clients (Claude Desktop, Cursor, Claude Code) handle this
transparently; if you fork a client, serialize outgoing requests with
`JSON.stringify(obj) + '\n'` and parse incoming lines with `JSON.parse`.

To expose LLM reasoning to MCP clients (Claude Desktop, Cursor, Claude Code):

```bash
OPENCONTEXT_LLM_API_KEY=sk-... \
  opencontext-memory-mcp \
    --reasoning \
    --embedding-provider local \
    --memory-backend sqlite-vec
```

Tools exposed over stdio:

| Tool                     | Required args                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.health`          | —                                                                                                                                                                                              |
| `memory.search`          | `userId`, `query`, optional `limit`, `threshold`, `sources`, `botIds`, `documentIds`, `factTypes`, `synthesize`, `tiers`, **`reasoningStrategy`** (`"none" \| "rewrite" \| "iterative"`)        |
| `memory.writeRawMessage` | `userId`, `message: { role, content, platform?, botId?, factType?, peer?, ... }`                                                                                                               |
| `memory.getRawMessage`   | `userId`, `messageId`                                                                                                                                                                          |
| `memory.consolidate`     | `userId`, `query`, `ownerScope`, optional `tiers`, `dryRun`, `expectedVersion`, `llmPlanReview`, `plan`                                                                                        |

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
	"mcpServers": {
		"opencontext-memory": {
			"command": "npx",
			"args": ["-y", "memory-store", "memory-mcp"],
			"env": {
				"DATABASE_URL": "postgres://user:pass@host:5432/opencontext"
			}
		}
	}
}
```

For local dev against this monorepo, point at the built CLI directly:

```json
{
	"mcpServers": {
		"opencontext-memory": {
			"command": "node",
			"args": [
				"/path/to/opencontext/packages/memory-store/dist/server/cli-mcp.js"
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
		"opencontext-memory": {
			"command": "opencontext-memory-mcp"
		}
	}
}
```

After registering, the six `memory.*` tools become available inside the
editor. Tool calls appear in the chat like any other MCP tool.

## Subpath exports

| Subpath                                       | Contents                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `memory-store`                                | `createMemoryStore`, `attachMemoryGraphStore`, top-level types                                     |
| `memory-store/http`                           | `startHttpServer`, `StartedHttpServer`                                                            |
| `memory-store/mcp`                            | `startMcpServer`                                                                                  |
| `memory-store/unified-search`                 | `createUnifiedSearch(deps)` factory + result types                                                |
| `memory-store/raw-message-store`              | `createRawMessageStore`, `getRawMessageManager`, `isRawMessageStorageAvailable`                   |
| `memory-store/sqlite-raw-message-store`       | SQLite-vec raw-message manager (Tauri / desktop)                                                  |
| `memory-store/postgres-raw-message-factory`   | `registerPostgresFactory`, `resolvePostgresFactory`                                               |
| `memory-store/sqlite-vector-index`            | Direct sqlite-vec insight index helpers                                                           |
| `memory-store/chroma-memory-index`            | Direct chroma upsert / search helpers                                                             |
| `memory-store/memory-graph-write-policy`      | `resolveMemoryGraphWritePolicy`, allowlist gating                                                 |
| `memory-store/memory-graph-correction-policy` | `resolveMemoryGraphCorrectionPolicy`                                                              |

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
- `reflect()` and `consolidate()` reuse the same evidence pipeline;
  `reflect()` is read-only, `consolidate()` additionally persists
  via the graph store + storage adapter.
- `applyReflectedConsolidationPlan` is idempotent — `persistPlan`
  deduplicates on `operationId` and `deprecateRecords` no-ops on
  already-deprecated rows.

## See also

- [`docs/architecture.md`](../../docs/architecture.md) — the overall data
  model, lifecycle, and transport surfaces that the memory primitives
  plug into.
- [`docs/tutorials/03-advanced-usage.md`](../../docs/tutorials/03-advanced-usage.md#reflection-and-write-back)
  — end-to-end walkthrough of `reflect()` + `consolidate()`.
