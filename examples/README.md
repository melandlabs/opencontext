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

- **~130 `[OK  ]`** — every demo ran against the real API and asserted
  on real return values
- **2 `[SKIP]`** — `addChunk` (needs the host app's Drizzle schema) and
  live `search()` (needs `BRAVE_SEARCH_API_KEY`)
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
| [`src/demo/00-facade.ts`](./src/demo/00-facade.ts)             | `@melandlabs/opencontext` — `chunkText`, `estimateTokens`, `getModelPricing`, `isUserType`, `createMemoryStore().searchUnifiedMemory`                            | memory search skips if `better-sqlite3` cannot build                                                 |
| [`src/demo/01-rag-chunk.ts`](./src/demo/01-rag-chunk.ts)       | `@melandlabs/rag` — `chunkText` against a real multi-paragraph document                                                                                          | —                                                                                                    |
| [`src/demo/02-rag-vector-store.ts`](./src/demo/02-rag-vector-store.ts) | `@melandlabs/rag` — `SQLiteVecStore` opened against a real sqlite file, `similaritySearch` against `vec0`                                                       | `addChunk` + populated `similaritySearch` skip (needs the host app's Drizzle schema)                  |
| [`src/demo/03-memory-store.ts`](./src/demo/03-memory-store.ts) | `@melandlabs/memory-store` — `createMemoryStore()`, `searchUnifiedMemory()` with real `sources`, plus the standalone `createUnifiedSearch` factory               | skips if `better-sqlite3` cannot build                                                               |
| [`src/demo/04-ai.ts`](./src/demo/04-ai.ts)                     | `@melandlabs/ai` — `estimateTokens`, `getModelPricing`, `MODEL_PRICING` table inspection                                                                         | —                                                                                                    |
| [`src/demo/05-contracts.ts`](./src/demo/05-contracts.ts)       | `@melandlabs/contracts` — `USER_TYPES`, `INTEGRATION_IDS`, `isUserType()`, `isIntegrationId()`                                                                    | —                                                                                                    |
| [`src/demo/06-loop.ts`](./src/demo/06-loop.ts)                 | `@melandlabs/loop` — `LOOP_PATHS` constants, `ensureDirs`, `readPreferences`, `writePreferences` round-trip in a sandboxed `$HOME`                                | —                                                                                                    |
| [`src/demo/07-env-config.ts`](./src/demo/07-env-config.ts)     | `@melandlabs/env-config` — `isTauriMode`, `isServerMode`, `isProductionEnvironment`, `DEFAULT_AI_MODEL`                                                           | —                                                                                                    |
| [`src/demo/08-cron.ts`](./src/demo/08-cron.ts)                 | `@melandlabs/cron` — `validateCronExpression`, `computeNextRun`, determinism over a fixed instant                                                                | —                                                                                                    |
| [`src/demo/09-ui-runtime.ts`](./src/demo/09-ui-runtime.ts)     | `@melandlabs/ui-runtime` — `isTauri`, `isClient`, `isBrowser`, `getPlatformKind` under Node                                                                      | —                                                                                                    |
| [`src/demo/10-storage.ts`](./src/demo/10-storage.ts)           | `@melandlabs/storage` — `LocalStorageProvider.save/load/delete`, plus path-traversal defense (`../../escape` becomes `.._.._escape` inside the root)            | —                                                                                                    |
| [`src/demo/11-security.ts`](./src/demo/11-security.ts)         | `@melandlabs/security` — `TokenEncryption` (Fernet) with a throwaway key, `validateUrlForSSRF` (rejects plain HTTP, loopback, RFC1918, cloud-metadata), `isTrustedStorageUrl` | —                                                                                                    |
| [`src/demo/12-search.ts`](./src/demo/12-search.ts)             | `@melandlabs/search` — `needsRealTimeInfo` classifier on time-sensitive vs timeless queries, then live `search()`                                              | live `search()` skips without `BRAVE_SEARCH_API_KEY`                                                 |
| [`src/demo/13-integrations-core.ts`](./src/demo/13-integrations-core.ts) | `@melandlabs/integrations` — `createMinimalContext({})` noop providers, partial overrides, `htmlToPlainText`, `buildSnippet`, `stripQuotedText`              | —                                                                                                    |

## Representative snippets

### [`src/demo/00-facade.ts`](./src/demo/00-facade.ts) — chunk and budget an article

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
`demo/04-ai.ts`.

### [`src/demo/02-rag-vector-store.ts`](./src/demo/02-rag-vector-store.ts) — local vector search

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

### [`src/demo/06-loop.ts`](./src/demo/06-loop.ts) — on-disk preferences

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
