# `@melandlabs/opencontext` examples

Runnable code samples for every package published from the `opencontext`
monorepo that has a Node-callable headline API. One file per package —
each one is a self-contained program that imports the published
`@melandlabs/*` package and exercises a real slice of its surface.

No mocks, no fakes, no framework glue. Most demos need no API keys or
live network calls; the two that do (`search()` for live web queries,
real embeddings) skip gracefully when the relevant env var or native
binding isn't present.

## Running them

```bash
git clone https://github.com/melandlabs/opencontext.git
cd opencontext/examples
pnpm install
pnpm test
```

`pnpm test` walks every demo in [`src/index.ts`](./src/index.ts), prints
one `[OK  ]` / `[SKIP]` / `[INFO]` line per check, and exits non-zero
if anything regresses. Expected output on a clean checkout:

- **~140 `[OK  ]`** — every demo ran against the real API and asserted
  on real return values
- **3 `[SKIP]`** — `addChunk` (needs the host app's Drizzle schema),
  live `search()` (needs `BRAVE_SEARCH_API_KEY`), and the live
  `agent.run(...)` call in demo 17 (needs `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` / `OPENROUTER_API_KEY`)
- **0 `[FAIL]`**

Demos that touch the filesystem sandbox themselves under
`examples/.tmp/` and clean up after every run — that directory should
be empty once `pnpm test` returns.

Requires **Node 22.6+** (`--experimental-strip-types` is stable there).
`pnpm test` runs the suite directly from `.ts` source; no build step
is involved.

> **Out of scope here**: browser-only packages (`hooks`, `indexeddb`,
> `voice-kokoro`), CJS-only integration leaves (`weixin`, `whatsapp`,
> …), and pure-namespace utilities (`audit`, `config`, `db`, `insights`,
> `shared`, `i18n`, `api`). These don't have a Node-callable headline
> API to demonstrate and are covered by the per-package vitest suites
> under `packages/*/src/**/*.test.ts`.

## The demos, one file per package

| Demo                                                            | Package(s) exercised                                                                                                                                              | Skips                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`src/simple/00-facade.ts`](./src/simple/00-facade.ts)             | `@melandlabs/opencontext` — `chunkText`, `estimateTokens`, `getModelPricing`, `isUserType`, `createMemoryStore().searchUnifiedMemory`                            | memory search skips if `better-sqlite3` cannot build                                                 |
| [`src/simple/01-rag-chunk.ts`](./src/simple/01-rag-chunk.ts)       | `@melandlabs/rag` — `chunkText` against a real multi-paragraph document                                                                                          | —                                                                                                    |
| [`src/simple/02-rag-vector-store.ts`](./src/simple/02-rag-vector-store.ts) | `@melandlabs/rag` — `SQLiteVecStore` opened against a real sqlite file, `similaritySearch` against `vec0`                                                       | `addChunk` + populated `similaritySearch` skip (needs the host app's Drizzle schema)                  |
| [`src/simple/03-memory-store.ts`](./src/simple/03-memory-store.ts) | `@melandlabs/memory-store` — `createMemoryStore()`, `searchUnifiedMemory()` with real `sources`, plus the standalone `createUnifiedSearch` factory               | skips if `better-sqlite3` cannot build                                                               |
| [`src/simple/04-ai.ts`](./src/simple/04-ai.ts)                     | `@melandlabs/ai` — `estimateTokens`, `getModelPricing`, `MODEL_PRICING` table inspection                                                                         | —                                                                                                    |
| [`src/simple/05-contracts.ts`](./src/simple/05-contracts.ts)       | `@melandlabs/contracts` — `USER_TYPES`, `INTEGRATION_IDS`, `isUserType()`, `isIntegrationId()`                                                                    | —                                                                                                    |
| [`src/simple/06-loop.ts`](./src/simple/06-loop.ts)                 | `@melandlabs/loop` — `LOOP_PATHS` constants, `ensureDirs`, `readPreferences`, `writePreferences` round-trip in a sandboxed `$HOME`                                | —                                                                                                    |
| [`src/simple/07-env-config.ts`](./src/simple/07-env-config.ts)     | `@melandlabs/env-config` — `isTauriMode`, `isServerMode`, `isProductionEnvironment`, `DEFAULT_AI_MODEL`                                                           | —                                                                                                    |
| [`src/simple/08-cron.ts`](./src/simple/08-cron.ts)                 | `@melandlabs/cron` — `validateCronExpression`, `computeNextRun`, determinism over a fixed instant                                                                | —                                                                                                    |
| [`src/simple/09-ui-runtime.ts`](./src/simple/09-ui-runtime.ts)     | `@melandlabs/ui-runtime` — `isTauri`, `isClient`, `isBrowser`, `getPlatformKind` under Node                                                                      | —                                                                                                    |
| [`src/simple/10-storage.ts`](./src/simple/10-storage.ts)           | `@melandlabs/storage` — `LocalStorageProvider.save/load/delete`, plus path-traversal defense (`../../escape` becomes `.._.._escape` inside the root)            | —                                                                                                    |
| [`src/simple/11-security.ts`](./src/simple/11-security.ts)         | `@melandlabs/security` — `TokenEncryption` (Fernet) with a throwaway key, `validateUrlForSSRF` (rejects plain HTTP, loopback, RFC1918, cloud-metadata), `isTrustedStorageUrl` | —                                                                                                    |
| [`src/simple/12-search.ts`](./src/simple/12-search.ts)             | `@melandlabs/search` — `needsRealTimeInfo` classifier on time-sensitive vs timeless queries, then live `search()`                                              | live `search()` skips without `BRAVE_SEARCH_API_KEY`                                                 |
| [`src/simple/13-integrations-core.ts`](./src/simple/13-integrations-core.ts) | `@melandlabs/integrations` — `createMinimalContext({})` noop providers, partial overrides, `htmlToPlainText`, `buildSnippet`, `stripQuotedText`              | —                                                                                                    |
| [`src/simple/14-local-embedding.ts`](./src/simple/14-local-embedding.ts) | `@melandlabs/ai-rag` — `LocalTransformersEmbeddingProvider` (ONNX, default `Xenova/all-MiniLM-L6-v2`, 384 dims), `getConfiguredEmbeddingProvider` factory routing via `EMBEDDING_PROVIDER=local`, `cosineSimilarity` sanity check | inference calls skip if neither the HF cache nor the network is available (first run downloads ~30 MB of ONNX weights)              |
| [`src/simple/15-http-server.ts`](./src/simple/15-http-server.ts) | `@melandlabs/memory-store/http` — `startHttpServer` booted on a random high port with **all three** `unified.*` deps supplied (`embedQuery` from the local ONNX provider, in-memory `searchKnowledge` / `searchInsights` cosine indices), then real `GET /health` / `POST /v1/raw-messages` / `POST /v1/search` round-trips that assert `warnings[]` is empty and hits come back | inference-dependent checks skip on the same condition as demo 14                                                                 |
| [`src/simple/16-mcp-server.ts`](./src/simple/16-mcp-server.ts) | `@melandlabs/opencontext` — spawns `opencontext mcp` with `--embedding-provider local --memory-backend sqlite-vec --name --version`, then drives the daemon over stdio the way any MCP client would: full JSON-RPC handshake (`initialize` → `notifications/initialized` → `tools/list`), then `memory.writeRawMessage` (with `embedOnInsert: true`), `memory.searchUnified` (asserting ranked memory hits + no `embedQuery` warning), `memory.getRawMessage`, and `memory.health`. Mirrors the `claude_desktop_config.json` snippet in the README §4. | inference-dependent checks skip on the same condition as demo 14                                                                |
| [`src/simple/17-ai-agent.ts`](./src/simple/17-ai-agent.ts)         | `@melandlabs/ai` — `IAgent` / `BaseAgent` / `defineAgentPlugin` / `AgentRegistry` / `runAgentRuntimeRequest` reachable from the root, plus the built-in `StandaloneAgent` (single LLM call) round-tripped through `getAgentInstance` | live `agent.run(...)` skips without `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY`     |

### Daemon configuration

Both `opencontext http` and `opencontext mcp` (plus their standalone
bins `opencontext-memory-http` / `opencontext-memory-mcp`) take the
same `--embedding-provider` / `--*-backend` flag surface. Every flag
also accepts an env-var equivalent so the same options can be set in
docker / systemd units.

| Flag                              | Env var                  | Values                              | Wires                                                       |
| --------------------------------- | ------------------------ | ----------------------------------- | ----------------------------------------------------------- |
| `--port <n>`                      | `MEMORY_HTTP_PORT`       | int (default `7421`)                | HTTP listen port (`http` only)                              |
| `--host <h>`                      | `MEMORY_HTTP_HOST`       | string (default `127.0.0.1`)        | HTTP bind host (`http` only)                                |
| `--name <s>`                      | `MEMORY_MCP_NAME`        | string                              | MCP server name advertised to clients (`mcp` only)         |
| `--version <s>`                   | `MEMORY_MCP_VERSION`     | string                              | MCP server version (`mcp` only)                             |
| `--embedding-provider <name>`     | `EMBEDDING_PROVIDER`     | `local` \| `openrouter` \| `none`   | `unified.embedQuery` (default `none`)                       |
| `--embedding-model <name>`        | `EMBEDDING_MODEL`        | string                              | provider-specific model id                                  |
| `--memory-backend <name>`         | `MEMORY_BACKEND`         | `sqlite-vec` \| `chroma` \| `none`  | `unified.searchRawMessagesAnn` (default `none`)             |
| `--insights-backend <name>`       | `INSIGHTS_BACKEND`       | `sqlite-vec` \| `chroma` \| `none`  | `unified.searchInsights` (default `none`)                   |
| `--insights-collection <name>`    | `INSIGHTS_COLLECTION`    | string (default `opencontext_insights`) | Chroma collection name for `--insights-backend=chroma`  |
| `--knowledge-backend <name>`      | `KNOWLEDGE_BACKEND`      | `chroma` \| `none`                  | `unified.searchKnowledge` (default `none`)                  |
| `--knowledge-collection <name>`   | `KNOWLEDGE_COLLECTION`   | string (default `opencontext_knowledge`) | Chroma collection name for `--knowledge-backend=chroma` |
| `--chroma-url <url>`              | `CHROMA_URL`             | http URL                            | required by any `--*-backend=chroma`                        |

Three concrete recipes:

```bash
# 1. Local ONNX embedder + sqlite-vec ANN for the memory source. No API
#    key, no extra services. Covers `opencontext http` AND `opencontext mcp`.
opencontext http \
  --embedding-provider local \
  --memory-backend sqlite-vec

# 2. Wire everything via a running Chroma server (uses OpenRouter for
#    embeddings). Requires `OPENROUTER_API_KEY` in the environment.
OPENROUTER_API_KEY=sk-or-v1-... \
opencontext http \
  --embedding-provider openrouter \
  --chroma-url http://127.0.0.1:8000 \
  --memory-backend chroma \
  --insights-backend chroma \
  --knowledge-backend chroma

# 3. Bare daemon (default) — only /health works and /v1/search returns
#    three structured `*_not_configured` / `memory_search_failed`
#    warnings. The bin emits no extra logs.
opencontext http
```

`--embedding-provider local` and every `--*-backend=chroma` value
require `@melandlabs/ai-rag` (a peer install — it pulls in
`@huggingface/transformers`, `chromadb`, and ~30 MB of ONNX weights
on first run). The bin fails with a clear remediation message if the
package is missing.

### `POST /v1/raw-messages` — `embedOnInsert`

When the daemon is booted with `--embedding-provider local|openrouter`
(or the host wires its own `unified.embedQuery`), the HTTP route
auto-fills any missing `embedding` on incoming messages if the request
body carries `"embedOnInsert": true`. Without that flag, the server
stores the row verbatim — clients that pre-embed client-side keep
their full pipeline.

```bash
curl -X POST http://127.0.0.1:7421/v1/raw-messages \
  -H 'content-type: application/json' \
  -d '{
        "userId": "u-42",
        "embedOnInsert": true,
        "messages": [
          { "role": "user", "messageId": "m-1",
            "content": "User prefers dark mode",
            "platform": "test", "botId": "b-1",
            "timestamp": 1700000000000, "createdAt": 1700000000000 }
        ]
      }'
# → { "ok": true, "count": 1, "result": { "inserted": 1, "ids": [1] } }
```

The MCP `writeRawMessage` tool takes the same flag as
`arguments.embedOnInsert`; demo 16 exercises it end-to-end.

### Wiring into Claude Desktop / Cursor

The MCP demo (16) exercises the same flag surface the `opencontext mcp`
CLI accepts. Drop this into `claude_desktop_config.json` (or Cursor →
Settings → MCP) — no API key, no extra services:

```json
{
	"mcpServers": {
		"opencontext": {
			"command": "npx",
			"args": ["-y", "@melandlabs/opencontext", "mcp",
			         "--embedding-provider", "local",
			         "--memory-backend", "sqlite-vec"]
		}
	}
}
```

Four tools are exposed: `memory.health`, `memory.searchUnified`,
`memory.writeRawMessage`, `memory.getRawMessage`.

## Representative snippets

### [`src/simple/00-facade.ts`](./src/simple/00-facade.ts) — chunk and budget an article

```ts
import {
	chunkText,
	estimateTokens,
	getModelPricing,
} from "@melandlabs/opencontext";

const article = "OpenContext is a runtime substrate for context-aware agents.";

const chunks = chunkText(article, { maxChunkSize: 80, chunkOverlap: 10 });
const tokens = estimateTokens(article);
const embeddingPrice = getModelPricing("text-embedding-3-small");
```

The facade re-exports both `@melandlabs/rag`'s and `@melandlabs/ai`'s
`getModelPricing`; the rag version wins the name collision and returns
the per-million-token price (a number), not the chat pricing object.
Import from `@melandlabs/ai` directly if you want the chat table — see
`04-ai.ts`.

### [`src/simple/02-rag-vector-store.ts`](./src/simple/02-rag-vector-store.ts) — local vector search

```ts
import { SQLiteVecStore } from "@melandlabs/rag";

const store = new SQLiteVecStore(dbPath, schemaModule); // opens a real sqlite file
const results = await store.similaritySearch(embedding, k);
//   → { id, documentId, content, distance, metadata }[]  (empty array if nothing matches)
store.close();
```

`SQLiteVecStore` provisions a `vec0` virtual table on top of `sqlite-vec`,
a loadable extension, so this is real KNN — no service to call, no
network involved. `addChunk` writes through Drizzle and therefore needs
the host app's schema module; this is documented inline in the demo
along with the parts that stand alone.

### [`src/simple/06-loop.ts`](./src/simple/06-loop.ts) — on-disk preferences

```ts
import { LOOP_PATHS, ensureDirs, readPreferences, writePreferences } from "@melandlabs/loop";

ensureDirs(); // creates ~/.opencontext/loop/ if missing
const defaults = readPreferences();          // built-in defaults when no config.json yet
const merged = writePreferences({ intervalSec: 42, narrative: false });
//   → full preferences object with the patch applied on top of the defaults
```

Loop keeps its state in `~/.opencontext/loop/`. The demo runs the
filesystem-touching calls in a child process whose `$HOME` is a
scratch directory, so the test never writes into your real home. In
your own app you call these functions directly.

## Used in production

The same primitives these demos exercise are wired into a real
end-user product: **[OpenLoomi](https://github.com/melandlabs/openloomi)**,
a cross-platform desktop "Attention Agent" that consumes the memory
API, retrieval primitives, loop engine, integrations mesh, and voice
packages to keep a short/mid/long-term _Holistic Context_ across
Gmail / Slack / Linear / Notion, run scheduled morning briefs and
end-of-day recaps, and surface on-demand assistance inside Telegram /
WhatsApp / iMessage / QQ / Feishu. See the
[OpenLoomi README](https://github.com/melandlabs/openloomi) for how
the same calls shown above power a real product.
