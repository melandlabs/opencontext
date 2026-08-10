# `@melandlabs/opencontext` examples

Runnable code samples for every package published from the
`opencontext` monorepo. One file per capability area — each one is a
self-contained program that imports the published `@melandlabs/*`
package and exercises a real slice of its surface.

No mocks, no fakes, no framework glue. No API keys or live network
calls are required.

## Running them

```bash
git clone https://github.com/melandlabs/opencontext.git
cd opencontext/examples
pnpm install
pnpm test
```

`pnpm test` walks every section in [`src/index.ts`](./src/index.ts),
prints one `[OK  ]` / `[SKIP]` / `[FAIL]` line per check, and exits
non-zero if anything regresses. Expected output on a clean checkout:

- **97 `[OK  ]`** — every package loads and the public API shape matches
- **3 `[SKIP]`** — upstream packages (Weixin, WhatsApp, …) that ship
  CJS without an `exports` field and can't be imported under pure ESM
- **0 `[FAIL]`**

## The full surface, one file per capability

| Example                                        | What it demonstrates                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`src/opencontext.ts`](./src/opencontext.ts)   | The `@melandlabs/opencontext` facade in one place — chunking, AI helpers, memory, loop, unified search                                                       |
| [`src/ai.ts`](./src/ai.ts)                     | Model pricing, token estimation, RAG helpers, MCP server scaffolding                                                                                         |
| [`src/memory.ts`](./src/memory.ts)             | `createMemoryStore()`, `createUnifiedSearch()`, the memory-consolidation entrypoint                                                                          |
| [`src/rag.ts`](./src/rag.ts)                   | `chunkText()` against real text, plus `SQLiteVecStore` / `ChromaVectorStore` constructors                                                                    |
| [`src/search.ts`](./src/search.ts)             | The Brave-backed `search()` helper and `needsRealTimeInfo()` routing                                                                                         |
| [`src/contracts.ts`](./src/contracts.ts)       | `USER_TYPES` / `INTEGRATION_IDS` constants, `isUserType()` / `isIntegrationId()` guards                                                                      |
| [`src/runtime.ts`](./src/runtime.ts)           | `loop.readPreferences()` / `loop.writePreferences()`, `hooks` (every `use*` export), `cron`, `env-config` environment flags                                  |
| [`src/storage.ts`](./src/storage.ts)           | `LocalStorageProvider`, `SQLiteRawMessageManager`, `initializeRawMessageSchema()`, `indexeddb` exports                                                       |
| [`src/security.ts`](./src/security.ts)         | `KeyManager`, `TokenEncryption`, `isTrustedStorageUrl()`, `validateUrlForSSRF()` (rejects plain `http://`)                                                   |
| [`src/utilities.ts`](./src/utilities.ts)       | `audit`, `config`, `db`, `insights`, `shared`, `i18n`, `api` — each loaded as a namespace so you see the live export shape                                   |
| [`src/integrations.ts`](./src/integrations.ts) | The integrations umbrella (`createMinimalContext`, `noopAuthProvider`, `cleanEmailForLLM`, `htmlToPlainText`, …) plus every leaf integration loading cleanly |
| [`src/voice.ts`](./src/voice.ts)               | `@melandlabs/voice-kokoro` (TTS) and `@melandlabs/voice-whisper` (STT) entry points                                                                          |

## Representative snippets

### [`src/rag.ts`](./src/rag.ts) — chunk a document for retrieval

```ts
import { chunkText } from "@melandlabs/rag";

const chunks = chunkText("Hello world. This is a test of the chunker.", {
	maxChunkSize: 12,
});
// chunks[0] → { content, startPosition, endPosition }
```

### [`src/memory.ts`](./src/memory.ts) — bring up the memory store

```ts
import {
	createMemoryStore,
	createUnifiedSearch,
} from "@melandlabs/memory-store";

const store = await createMemoryStore();
// store.raw.remember(...)  · store.search.searchUnifiedMemory(...)

const search = createUnifiedSearch({});
await search.searchUnifiedMemory({/* userId, query, sources, limit */});
```

### [`src/ai.ts`](./src/ai.ts) — token + cost helpers, no API keys

```ts
import {
	estimateTokens,
	getModelPricing,
	calculateTotalCredits,
} from "@melandlabs/ai";

estimateTokens("OpenContext is a runtime substrate.");
getModelPricing("gpt-4o-mini");
calculateTotalCredits(/* usage */);
```

### [`src/security.ts`](./src/security.ts) — SSRF-safe outbound calls

```ts
import { validateUrlForSSRF } from "@melandlabs/security";

await validateUrlForSSRF("https://api.example.com/v1/embeddings"); // ok
await validateUrlForSSRF("http://example.com/"); // throws
```

### [`src/integrations.ts`](./src/integrations.ts) — the integrations umbrella

```ts
import {
	createMinimalContext,
	noopAuthProvider,
} from "@melandlabs/integrations/core";
import {
	cleanEmailForLLM,
	htmlToPlainText,
	buildSnippet,
} from "@melandlabs/integrations/utils";
import { ComposioClient } from "@melandlabs/integrations-composio";
```

## Used in production

The same primitives these examples demonstrate are wired into a real,
end-user product: **[OpenLoomi](https://github.com/melandlabs/openloomi)**,
a cross-platform desktop "Attention Agent" that consumes the memory API,
retrieval primitives, loop engine, integrations mesh, and voice packages
to keep a short/mid/long-term _Holistic Context_ across Gmail / Slack /
Linear / Notion, run scheduled morning briefs and end-of-day recaps, and
surface on-demand assistance inside Telegram / WhatsApp / iMessage / QQ /
Feishu. See the [OpenLoomi README](https://github.com/melandlabs/openloomi)
for how the same calls shown above power a real product.
