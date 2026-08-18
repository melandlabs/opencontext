# Advanced Usage - Production Patterns

This guide covers advanced patterns for running OpenContext in production: multi-source search, temporal queries, platform integrations, and the Loop engine.

## Multi-Source Unified Search

OpenContext can search across multiple data sources simultaneously. The default setup searches raw memory with a lexical fallback; to enable semantic search you wire an `embedQuery` function. You can also plug in optional `searchInsights` and `searchKnowledge` providers to search extracted facts and uploaded documents in the same call.

```typescript
// multi-source-search-example.ts
// Run with: npx tsx multi-source-search-example.ts
// Note: semantic search needs @melandlabs/ai-rag installed.
import { createMemoryStore, LocalTransformersEmbeddingProvider } from "@melandlabs/opencontext";

async function main() {
  const embeddingProvider = new LocalTransformersEmbeddingProvider({
    modelName: "Xenova/all-MiniLM-L6-v2",
  });

  const store = await createMemoryStore({
    unified: {
      embedQuery: async ({ query }) => {
        return await embeddingProvider.embedQuery(query);
      },

      // Optional: search extracted insights (provide your own index).
      searchInsights: async ({ userId, query, limit, threshold }) => {
        // Replace with your insights index, e.g. vector DB or graph search.
        console.log("Searching insights for:", { userId, query, limit, threshold });
        return [];
      },

      // Optional: search uploaded documents (provide your own RAG index).
      searchKnowledge: async ({ userId, query, options }) => {
        // Replace with your knowledge-base index.
        console.log("Searching knowledge for:", { userId, query, options });
        return [];
      },
    },
  });

  const results = await store.search({
    userId: "user-123",
    query: "What did we decide about the architecture?",
    sources: ["memory", "insights", "knowledge"],
    limit: 10,
    threshold: 0.7,
    botIds: ["architect-bot"],  // Optional: filter by bot
    documentIds: ["doc-456"],   // Optional: filter by document
  });

  console.log(`Searched ${results.sources.length} source(s)`);
  for (const warning of results.warnings) {
    console.warn(`[${warning.source}] ${warning.code}: ${warning.message}`);
  }
  for (const hit of results.results) {
    console.log(`[${hit.type}] ${hit.content} (${hit.similarity})`);
  }

  await store.raw.close();
}

main().catch((error) => {
  console.error("Multi-source search failed:", error);
  process.exit(1);
});
```

## Reflection and Write-Back

The four-verb memory API (`remember`, `recall`, `forget`, `improve`) covers the day-to-day operations of an agent: write a fact, recall it, archive it, supersede it. This section covers the **fifth** operation — `reflect` — which gathers evidence and either synthesises an answer or, in write-back mode, asks the LLM to vet a consolidation plan and persists the result.

There are two flavours, sharing the same evidence pipeline:

| Method | Writes? | Purpose |
|---|---|---|
| `store.search({ ...input, synthesize: true })` | **No** | Read-only LLM synthesis over unified evidence |
| `store.consolidate(input)` | **Yes** | Agentic gather → plan → vet → persist loop |

Both methods are also exposed over HTTP and MCP:

| Transport | Read-only | Write-back |
|---|---|---|
| SDK | `store.search({ ...input, synthesize: true })` | `store.consolidate(input)` |
| HTTP | `POST /v1/search` (set `synthesize: true`) | `POST /v1/consolidate:apply` |
| MCP | `memory.search` (set `synthesize: true`) | `memory.consolidate` |

### Read-only `search({ synthesize: true })`

`store.search({ ...input, synthesize: true })` fans a single query out across **four tiers**:

1. **Raw messages** — `searchRawMessagesAnn` (semantic) + `searchRawMessagesLexical` (BM25)
2. **Summaries** — `searchSummaries` (L1/L2/L3)
3. **Insights** — `searchInsights`
4. **Knowledge** — `searchKnowledge` (uploaded RAG docs)

…then asks the configured LLM (`unified.reasoning.complete`) to produce a single synthesised answer with bracket-cited evidence. No writes.

```ts
import { createMemoryStore } from "@melandlabs/opencontext";

const store = await createMemoryStore({
	unified: {
		embedQuery: async ({ query }) => myEmbedder.embed(query),
		searchSummaries: mySummariesBackend,
		searchInsights: myInsightsBackend,
		searchKnowledge: myKnowledgeBackend,
		reasoning: {
			complete: async (prompt) => myLlm.complete(prompt),
		},
	},
});

const out = await store.search({
	userId: "u-42",
	query: "what does the user like to do on weekends?",
	tiers: ["summary", "raw", "insight", "knowledge"],
	limit: 20,
	threshold: 0.7,
	synthesize: true,
});

console.log(out.answer); // LLM synthesis, bracket-cites [1], [2], …
console.log(out.evidence); // the underlying evidence items
console.log(out.warnings); // structured warnings, never throws
```

**Behaviour under failure**:

- No LLM configured → returns the gathered evidence with a `reflect_llm_not_configured` warning instead of throwing.
- LLM throws → evidence is preserved, a `reflect_llm_failed` warning is added, `out.answer` falls back to the raw evidence text.
- Tier provider absent → the tier is skipped silently.
- Empty `query` → short-circuits with `{ evidence: [], warnings: [] }`.

### Agentic write-back `consolidate()`

`consolidate()` is the additive write counterpart. The loop is:

```
    ┌──────────────┐    ┌─────────────────┐    ┌────────────┐
    │ gather (4tier)│ →  │ build plan (rule)│ →  │ vet w/ LLM │ (optional)
    └──────────────┘    └─────────────────┘    └────────────┘
                                                       ↓
                            ┌─────────────────┐    ┌──────────────┐
                            │ deprecateRecords │ ←  │ persistPlan  │ (graph store)
                            │  storage adapter │    └──────────────┘
                            └─────────────────┘
```

1. **Gather** — same evidence pipeline as `search({ synthesize: true })`.
2. **Build plan** — `buildMemoryConsolidationPlan(records, thresholds)` produces a `MemoryConsolidationPlan` with `preserve` / `decay` / `deprecate` entries. Rule-based; no LLM invention.
3. **Vet (optional)** — when `reasoning.complete` is configured, the LLM is asked to approve or veto each entry. It may only mark entries as `approve` / `veto` with a reason; it cannot add new operations.
4. **Persist** — `graphStore.persistPlan(translate(plan))` writes the graph updates; `storage.deprecateRecords(...)` soft-deprecates the records replaced by `deprecate` entries.

```ts
import { createMemoryStore, attachMemoryGraphStore } from "@melandlabs/opencontext";

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
console.log(dry.plan); // MemoryConsolidationPlan
console.log(dry.applied); // false

// 3. Apply for real.
const result = await store.consolidate({
	userId: "u-42",
	query: "summarise the last week",
	ownerScope: { userId: "u-42" },
	tiers: ["raw", "summary"],
	dryRun: false,
});
console.log(result.applied); // true
console.log(result.persistenceResult); // { applied, skipped, conflicts }
console.log(result.deprecationCounts); // [{ supersededBySummaryId, count }]
```

#### Failure modes

Each failure mode emits a typed warning and falls back deterministically:

| Code | Triggered when | Behaviour |
|---|---|---|
| `reflect_apply_llm_skipped` | No `reasoning.complete` configured | The rule-based plan runs without vet. |
| `reflect_apply_llm_vet_failed` | LLM threw or returned invalid JSON | All entries marked `approve` (no-op plan). |
| `reflect_apply_graph_store_not_configured` | No graph store attached | `deprecateRecords` still runs against the storage adapter. |
| `reflect_apply_dry_run` | `dryRun: true` | Nothing is written; `applied: false`. |
| `reflect_apply_no_writes` | Plan has no actionable entries | `applied: false`, returns the plan for inspection. |

#### Replay / A/B testing

The `plan` field accepts a pre-built `MemoryConsolidationPlan`. Skips the plan-builder step so the same input can be replayed against different LLM configurations:

```ts
const dry1 = await store.consolidate({
	/* … */
	dryRun: true,
});
// dry1.plan is a MemoryConsolidationPlan

const replayed = await store.consolidate({
	/* same inputs */
	plan: dry1.plan,
});
```

### FactType classification

Atomic facts are classified as one of three kinds, declared in `@melandlabs/ai/memory/contracts`:

```ts
type FactType = "world" | "experience" | "mental_model";
```

| Kind | Meaning |
|---|---|
| `world` | Facts about the world (e.g. "water boils at 100 °C"). |
| `experience` | First-person events ("I went hiking last weekend"). |
| `mental_model` | Generalised patterns ("the user prefers outdoors on weekends"). |

The classifier runs at LLM extraction time; the result rides along the `RawMessage.factType?` field and surfaces on `MemoryRecord.factType`. The read-side filter `MemorySearchQuery.factTypes` lets a caller narrow a search to one or more kinds:

```ts
await store.search({
	userId: "u-42",
	query: "what did I do last weekend?",
	sources: ["memory"], // restrict to memory source — insights/knowledge don't carry factType
	factTypes: ["experience"],
});
```

Schema migration: IndexedDB `DB_VERSION` 3 → 4, SQLite `RAW_MESSAGES_SCHEMA_VERSION` 3 → 4. Both are idempotent and tolerate v3 rows whose `factType` is undefined.

### End-to-end example

The same surface is also covered by the demos at [`examples/src/simple/15-http-server.ts`](../../examples/src/simple/15-http-server.ts) (HTTP) and [`examples/src/simple/16-mcp-server.ts`](../../examples/src/simple/16-mcp-server.ts) (MCP). A dedicated runnable companion for the reflect / write-back loop is on the roadmap and will be re-added once `@melandlabs/memory-store@0.4.0` ships to npm.

## Reasoning-Backed Memory Retrieval

Dense retrieval works best when the query matches the language of the stored memories. Chat logs are usually written in the first person ("I told you I prefer dark mode"), but agents often ask questions in the third person ("What does the user prefer?"). OpenContext can plug in small LLM-powered reasoning providers to close that gap.

Two strategies are available:

- `rewrite`: rephrases the assistant's question into a first-person memory-check question before running semantic search.
- `iterative`: runs a small ReAct-style planner that searches, notes evidence, and searches again — useful for multi-hop or temporally constrained questions.

Configure them through `unified.reasoning`:

```typescript
// reasoning-memory-example.ts
// Run with: node --env-file=../.env --experimental-strip-types src/tutorials/10-reasoning-memory-example.ts
import {
  createMemoryReasoningProviders,
  createMemoryStore,
  getRawMessageManager,
  LocalTransformersEmbeddingProvider,
} from "@melandlabs/opencontext";

async function main() {
  const embeddingProvider = new LocalTransformersEmbeddingProvider({
    modelName: "Xenova/all-MiniLM-L6-v2",
  });

  // Reads OPENCONTEXT_LLM_API_KEY / BASE_URL / MODEL from the environment.
  const reasoning = createMemoryReasoningProviders({});

  const store = await createMemoryStore({
    dbPath: "./tutorials-reasoning.db",
    unified: {
      embedQuery: async ({ query }) => embeddingProvider.embedQuery(query),
      reasoning: {
        queryRewriter: reasoning.queryRewriter,
        iterativePlanner: reasoning.iterativePlanner,
      },
    },
  });

  // ...store messages, then search with a reasoning strategy...
  const results = await store.search({
    userId: "user-42",
    query: "What does the user enjoy doing on weekends?",
    reasoningStrategy: "rewrite", // or "iterative"
    limit: 5,
    threshold: 0.0,
  });

  console.log(`Found ${results.count} result(s)`);
  console.log("Reasoning metadata:", results.reasoning);
  for (const hit of results.results) {
    console.log(`- ${hit.content}`);
  }

  await store.raw.close();
}

main().catch((error) => {
  console.error("Reasoning search failed:", error);
  process.exit(1);
});
```

Required environment variables:

```bash
OPENCONTEXT_LLM_API_KEY=your-key
OPENCONTEXT_LLM_BASE_URL=https://api.deepseek.com/v1   # or any OpenAI-compatible endpoint
OPENCONTEXT_LLM_MODEL=deepseek-chat                    # or e.g. openai/gpt-4o-mini
```

Optional tuning variables for the iterative planner:

```bash
OPENCONTEXT_LLM_REASONING_MAX_ITERATIONS=4   # maximum planner actions per search
OPENCONTEXT_LLM_REASONING_SEARCH_TOP_K=5     # results exposed to the planner per internal search
```

You can also pass these values explicitly when constructing providers:

```typescript
const reasoning = createMemoryReasoningProviders({}, {
  planner: { maxIterations: 6, searchTopK: 10 },
});
```

The `reasoning` field on the result tells you which strategy ran and includes diagnostic details such as rewritten queries or iteration counts. If no reasoning providers are configured, setting `reasoningStrategy` emits a warning and falls back to the default search path.

> Runnable example: `examples/src/tutorials/10-reasoning-memory-example.ts`

### Server-wide Default

Callers usually want one global default — every search on this store should use the planner unless the caller overrides it. Set `unified.reasoning.defaultStrategy` when constructing the store:

```typescript
const store = await createMemoryStore({
  dbPath: "./tutorials-reasoning.db",
  unified: {
    embedQuery: async ({ query }) => embeddingProvider.embedQuery(query),
    reasoning: {
      queryRewriter: reasoning.queryRewriter,
      iterativePlanner: reasoning.iterativePlanner,
      // No per-call reasoningStrategy? Use this as the default.
      defaultStrategy: "iterative",
    },
  },
});

// Inherits "iterative" from the store config.
const results = await store.search({ userId: "u-1", query: "..." });

// Per-call value still wins.
const adHoc = await store.search({
  userId: "u-1",
  query: "...",
  reasoningStrategy: "rewrite",
});
```

Resolution order at lookup time is: per-call `reasoningStrategy` → store-level `unified.reasoning.defaultStrategy` → `"none"`. Set `defaultStrategy: "none"` explicitly if you want to opt out of a default that another module turned on.


### Date-Range Filtering

In addition to the single-point `asOf` snapshot, you can pass an inclusive `dateFrom` / `dateTo` range to restrict the memory source to a calendar window. The iterative planner receives the bounds and may emit narrower ranges in its own search actions; the default one-shot path simply filters candidates by their timestamp metadata.

> Note: `dateFrom` / `dateTo` only filter the `memory` source. `insights` and `knowledge` results are not affected by this range, and memory candidates without a recognised timestamp are retained.

```typescript
const results = await store.search({
  userId: "user-42",
  query: "What outdoor activities did I mention last summer?",
  reasoningStrategy: "iterative",
  dateFrom: "2024-06-01",
  dateTo: "2024-08-31",
  limit: 5,
  threshold: 0.0,
});

console.log("Reasoning metadata:", results.reasoning);
// -> { strategy: "iterative", dateRange: { from: "2024-06-01", to: "2024-08-31" }, ... }
```

`asOf` and `dateFrom/dateTo` are intentionally different:

- `asOf` asks "what was true at this exact instant?" — a temporal snapshot over facts with validity windows.
- `dateFrom` / `dateTo` ask "which memories were recorded inside this calendar window?" — an interval filter over message timestamps.

## Vector Symbolic Architecture (VSA) Recall

`store.search()` returns the top-K nearest neighbours by cosine similarity. That's the right tool when the answer is "what's close to X?". Sometimes the right tool is "given a closed vocabulary, which entry matches X?". That's what VSA is for: it stores (role, filler) bindings as holographic reduced representations (HRR), and at recall time it superposes every stored binding, unbinds by the requested role, and picks the best-match vocabulary entry by cosine cleanup.

The two surfaces are intentionally separate — VSA recall is a single best-match, not a ranked list. Folding both into one result shape would require a confusing union type and a fake `similarity` field that doesn't mean the same thing across sources.

### When to use VSA

VSA shines when:

- You have a **closed, labelled answer space** (a vocabulary). E.g. `mood ∈ { "happy", "neutral", "tired" }`.
- The question can be phrased as a **role lookup** ("what is the user's mood?").
- You want **millisecond-scale recall** over a few thousand facts.
- The role→filler relation is dense — you have many examples of "for this user, on a question like this, the answer is Y".

Reach for semantic search instead when:

- The answer space is open-ended (long-form text, document retrieval).
- You need multiple candidates ranked by similarity.
- The vocabulary is too large for cleanup to discriminate (rule of thumb: D ≥ √N where N is the vocabulary size).

### The four verbs

`createMemoryStore()` always returns a `store.vsa` facade backed by the same SQLite database as the raw-message store. The four verbs are:

| Verb | Purpose |
| --- | --- |
| `vsaStoreFact` | Persist a `(role, filler)` binding as a HRR pair. Idempotent on `factId`. |
| `vsaRecall` | Re-superpose all stored facts for the user/scope, unbind by the requested role, cleanup against a vocabulary, return the best-match label. |
| `vsaListFacts` | Read-side projection of stored facts (no vectors). Useful for diagnostics and audit. |
| `vsaForget` | Soft-delete by id. Idempotent. |

### End-to-end example

```typescript
import { createMemoryStore } from "@melandlabs/memory-store";
import { randomHRRVector } from "@melandlabs/vsa";

const DIM = 128;

function toVector(seed: number): number[] {
  const v = randomHRRVector(DIM, seed);
  return Array.from(v.data);
}

async function main() {
  const store = await createMemoryStore();

  const vocabulary = [
    { label: "happy",   vector: toVector(1) },
    { label: "neutral", vector: toVector(2) },
    { label: "tired",   vector: toVector(3) },
  ];

  const roleVector = toVector(100);
  const fillerVector = vocabulary[0].vector;

  // Persist three (role, filler) bindings. Each call returns a unique
  // factId; the superposed memory vector grows by one term per fact.
  for (let i = 0; i < 3; i += 1) {
    await store.vsa.storeFact({
      userId: "user-123",
      scopeTag: "demo",
      roleLabel: "user:mood",
      roleVector,
      fillerLabel: "happy",
      fillerVector,
      dim: DIM,
    });
  }

  // Recall — given the same role vector, the superposed memory vector
  // should decode to the most-bound filler.
  const recall = await store.vsa.recall({
    userId: "user-123",
    scopeTag: "demo",
    roleLabel: "user:mood",
    roleVector,
    vocabulary,
  });

  console.log(recall.fillerLabel); // → "happy"
  console.log(recall.allScores);  // → [{ label: "happy", score: 0.7 }, ...]
}
```

### HTTP / MCP exposure

The same verbs are exposed over HTTP and MCP for any host that doesn't want to wire `createMemoryStore` directly:

- `POST /v1/vsa/store` — `vsaStoreFact`
- `POST /v1/vsa/recall` — `vsaRecall`
- `POST /v1/vsa/list` — `vsaListFacts`
- `POST /v1/vsa/forget` — `vsaForget`

And the MCP tool names are `memory.vsaStore`, `memory.vsaRecall`, `memory.vsaList`, `memory.vsaForget`.

### Capacity notes

HRR superpositions tolerate noise gracefully but degrade as you approach √D stored facts (rule of thumb from Plate, 1995). For `D = 128` that's roughly 11 facts before crosstalk dominates a single best-match cleanup. For dense recall (thousands of facts) use `D = 512` or `D = 1024`. The facade accepts whatever dimension you store; mismatches between facts with different `dim` values are surfaced as `vsa_dim_mismatch` warnings and dropped before superposition.

> Runnable example: `examples/src/simple/19-vsa.ts`

## Temporal (Time-Travel) Queries

Every fact has `valid_from` and `valid_until`, enabling queries as of a specific time. Pass an ISO-8601 string to `asOf`:

```typescript
// temporal-query-example.ts
// Run with: npx tsx temporal-query-example.ts
import { createMemoryStore } from "@melandlabs/opencontext";

async function main() {
  const store = await createMemoryStore();

  // What did we believe about the project last month?
  const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const results = await store.search({
    userId: "user-123",
    query: "project status and timeline",
    asOf: lastMonth,  // Query as of this ISO-8601 timestamp
    limit: 10,
  });

  console.log(`Found ${results.count} fact(s) that were true last month`);
  for (const hit of results.results) {
    console.log(`- ${hit.content}`);
  }

  await store.raw.close();
}

main().catch((error) => {
  console.error("Temporal query failed:", error);
  process.exit(1);
});
```

**Use cases:**
- Audit: "What was the strategy on April 1st?"
- Debugging: "Why did we make that decision last week?"
- Compliance: "What information did we have then?"

> Runnable example: `examples/src/tutorials/05-time-travel-example.ts`

## Working with the Temporal Graph

For more advanced temporal queries, inspect the raw-message store directly. Every message records when it was created, archived, or deprecated, so you can reconstruct the history of a fact without a separate graph API:

```typescript
// temporal-graph-example.ts
// Run with: npx tsx temporal-graph-example.ts
import { getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  const manager = await getRawMessageManager();

  // Query active facts for a user.
  const active = await manager.queryMessages({
    userId: "user-123",
    keywords: ["project status"],
    includeArchived: false,
  });

  console.log(`Active facts: ${active.length}`);
  for (const msg of active) {
    console.log(`- ${msg.content}`);
  }

  // Query deprecated / corrected facts to see what changed over time.
  const deprecated = await manager.queryMessages({
    userId: "user-123",
    includeArchived: true,
  });

  console.log("\nDeprecated or archived facts:");
  for (const msg of deprecated) {
    if (msg.deprecatedAt || msg.archivedAt) {
      console.log(
        `- ${msg.content}\n  deprecatedAt: ${msg.deprecatedAt ?? "n/a"}\n  archivedAt: ${msg.archivedAt ?? "n/a"}\n  reason: ${msg.deprecationReason ?? "n/a"}`,
      );
    }
  }
}

main().catch((error) => {
  console.error("Temporal graph query failed:", error);
  process.exit(1);
});
```

> See also `examples/src/tutorials/17-memory-service.ts` for a reusable service wrapper around the raw-message store.

## Platform Integrations

OpenContext supports multiple platforms. Integration IDs are exported from the contracts package, and each platform has a dedicated adapter under `@melandlabs/integrations/*`.

### Available Platforms

```typescript
// list-integrations-example.ts
// Run with: npx tsx list-integrations-example.ts
import { INTEGRATION_IDS } from "@melandlabs/opencontext";

console.log("Supported integrations:");
for (const id of INTEGRATION_IDS) {
  console.log(`- ${id}`);
}
```

### Ingesting Platform Messages

There is no single `IntegrationManager` facade. Each platform adapter (e.g. `@melandlabs/integrations/gmail`, `@melandlabs/integrations/slack`) returns messages in its own shape. A typical ingestion loop normalizes those messages into `RawMessage` records and stores them:

```typescript
// ingest-messages-example.ts
// Run with: npx tsx ingest-messages-example.ts
import { getRawMessageManager } from "@melandlabs/opencontext";
import type { RawMessage } from "@melandlabs/opencontext";

interface PlatformMessage {
  id: string;
  userId: string;
  content: string;
  platform: string;
  timestamp: number;
}

async function ingestMessages(messages: PlatformMessage[]) {
  const manager = await getRawMessageManager();

  const rawMessages: RawMessage[] = messages.map((msg) => ({
    messageId: msg.id,
    userId: msg.userId,
    content: msg.content,
    platform: msg.platform,
    botId: "ingest-bot",
    timestamp: msg.timestamp,
    createdAt: Date.now(),
  }));

  const ids = await manager.storeMessages(rawMessages);
  console.log(`Ingested ${ids.length} message(s)`);
}

async function main() {
  // Replace this with a real adapter call, e.g. fetchGmailMessages(userId).
  const exampleMessages: PlatformMessage[] = [
    {
      id: `msg-${Date.now()}`,
      userId: "user-123",
      content: "Meeting moved to 3pm",
      platform: "gmail",
      timestamp: Date.now(),
    },
  ];

  await ingestMessages(exampleMessages);
}

main().catch((error) => {
  console.error("Ingestion failed:", error);
  process.exit(1);
});
```

See the individual `@melandlabs/integrations-*` packages for platform-specific authentication, fetching, and sending APIs.

### Platform Adapter Examples

- `examples/src/tutorials/12-integration-ids-example.ts` — list every supported integration ID.
- `examples/src/tutorials/38-channels-example.ts` — build and round-trip platform adapter error envelopes.
- `examples/src/tutorials/39-integrations-runtime-example.ts` — platform display info, connectability checks, and task-integration inference.
- `examples/src/tutorials/40-contracts-example.ts` — validate user types and integration IDs from the contracts package.

## The Loop Engine

The Loop engine is a deterministic scheduler that wakes your agent on a schedule. It stores its config in `~/.opencontext/loop/config.json`.

```typescript
// loop-engine-example.ts
// Run with: npx tsx loop-engine-example.ts
import {
  LOOP_PATHS,
  ensureDirs,
  readPreferences,
  writePreferences,
} from "@melandlabs/opencontext";

async function main() {
  // Ensure Loop directories exist
  ensureDirs();

  // Read current preferences (or get defaults)
  const prefs = readPreferences();
  console.log("Current tick interval:", prefs.intervalSec, "seconds");
  console.log("Loop enabled:", prefs.enabled);

  // Update preferences. Only the fields you pass are patched.
  const updated = writePreferences({
    enabled: true,
    intervalSec: 300,          // Tick every 5 minutes
    narrative: true,           // Generate narrative brief/wrap
    briefTime: "09:00",        // Morning brief at 9 AM
    wrapTime: "21:00",         // Evening wrap at 9 PM
  });

  console.log("Updated preferences:", updated);
  console.log("Config file:", LOOP_PATHS.config);
}

main().catch((error) => {
  console.error("Loop engine example failed:", error);
  process.exit(1);
});
```

### Loop Configuration File

After running the example, `~/.opencontext/loop/config.json` looks similar to:

```json
{
  "enabled": true,
  "intervalSec": 300,
  "narrative": true,
  "briefTime": "09:00",
  "wrapTime": "21:00",
  "noReplySkip": true,
  "promotionSkip": true
}
```

> Runnable example: `examples/src/tutorials/11-loop-example.ts`

### Scheduled Tasks

Use the `@melandlabs/cron` package to validate cron expressions and compute the next run time:

```typescript
// scheduled-tasks-example.ts
// Run with: npx tsx scheduled-tasks-example.ts
import { computeNextRun, validateCronExpression } from "@melandlabs/opencontext";

async function main() {
  // Validate a cron expression
  const isValid = validateCronExpression("0 9 * * *");  // Daily at 9 AM
  console.log("Cron valid:", isValid);

  // Compute next run time. computeNextRun takes a ScheduleConfig object.
  const nextRun = computeNextRun(
    { type: "cron", expression: "0 9 * * *" },
    new Date(),
  );

  if (nextRun) {
    console.log("Next run:", nextRun.toISOString());
  } else {
    console.log("No next run scheduled");
  }
}

main().catch((error) => {
  console.error("Scheduled task example failed:", error);
  process.exit(1);
});
```

> Runnable examples:
> - `examples/src/tutorials/21-scheduled-tasks-example.ts` — compute next cron run times.
> - `examples/src/tutorials/29-cron-example.ts` — validate expressions, compute next runs, and check `isJobDue`.

## Encryption and Security

These utilities are re-exported from `@melandlabs/opencontext` for convenience.

### Encrypting Secrets

`TokenEncryption` reads the key from the `ENCRYPTION_KEY` environment variable and expects a 32-byte value (or a password from which a 32-byte key is derived).

```typescript
// token-encryption-example.ts
// Run with: ENCRYPTION_KEY=your-32-byte-key-here!!!! npx tsx token-encryption-example.ts
import { TokenEncryption } from "@melandlabs/opencontext";

async function main() {
  const encryptor = new TokenEncryption();

  const original = "sk-1234567890abcdef";

  // encryptToken / decryptToken are synchronous
  const encrypted = encryptor.encryptToken(original);
  console.log("Encrypted:", encrypted);

  const decrypted = encryptor.decryptToken(encrypted);
  console.log("Decrypted:", decrypted);
}

main().catch((error) => {
  console.error("Token encryption failed:", error);
  process.exit(1);
});
```

### URL Validation (SSRF Protection)

```typescript
// url-validation-example.ts
// Run with: npx tsx url-validation-example.ts
import { isTrustedStorageUrl, validateUrlForSSRF } from "@melandlabs/opencontext";

async function main() {
  // validateUrlForSSRF rejects plain HTTP, loopback and private IPs by default.
  // Pass { strictWhitelist: false } to skip the known-storage-provider whitelist.
  try {
    const safe = await validateUrlForSSRF("https://api.example.com/data", {
      strictWhitelist: false,
    });
    console.log("Safe URL:", safe.toString());
  } catch (error) {
    console.error("Unsafe URL:", error);
  }

  // Check if a storage URL is trusted
  const trusted = isTrustedStorageUrl("https://s3.amazonaws.com/my-bucket/file.txt");
  console.log("Trusted storage URL:", trusted);
}

main().catch((error) => {
  console.error("URL validation failed:", error);
  process.exit(1);
});
```

> Runnable examples:
> - `examples/src/tutorials/22-token-encryption-example.ts` — encrypt and decrypt a token with `TokenEncryption`.
> - `examples/src/tutorials/23-url-validation-example.ts` — validate URLs and check trusted storage URLs.

## Voice Capabilities

Voice plugins are re-exported from `@melandlabs/opencontext` for convenience. They are browser-oriented; the TTS plugin uses `HTMLAudioElement` and the STT plugin expects web `Blob` inputs, so these snippets are not runnable in a plain Node.js/CLI script.

### Text-to-Speech (Kokoro)

```typescript
// Browser-only example
import { KokoroPlugin } from "@melandlabs/opencontext";

const tts = new KokoroPlugin({ enabled: true, voice: "af_bella" });

// Speaks the text in the browser; returns a Promise that resolves when playback starts.
await tts.speak("Hello, world!");
```

### Speech-to-Text (Whisper)

`WhisperPlugin` transcribes audio using the OpenAI Whisper API (or a compatible endpoint).

```typescript
// whisper-example.ts
// Browser-only; run in an environment with Blob/File support.
import { WhisperPlugin } from "@melandlabs/opencontext";

async function main() {
  const stt = new WhisperPlugin({
    model: "whisper-1",
    apiKey: process.env.OPENAI_API_KEY,
  });

  // Load an audio file into a Blob. In the browser you can pass a File directly.
  const audioBuffer = Buffer.from(/* WAV bytes */);
  const audioBlob = new Blob([audioBuffer], { type: "audio/wav" });

  const result = await stt.transcribe({
    file: audioBlob,
    filename: "voice-input.wav",
  });

  console.log("Transcript:", result.text);
}

main().catch((error) => {
  console.error("Whisper transcription failed:", error);
  process.exit(1);
});
```

## Web Search Integration

Web search utilities are re-exported from `@melandlabs/opencontext` for convenience.

```typescript
// web-search-example.ts
// Run with: BRAVE_SEARCH_API_KEY=your-key npx tsx web-search-example.ts
import { needsRealTimeInfo, search } from "@melandlabs/opencontext";

async function main() {
  // Classify if a query needs real-time info
  const needsLive = needsRealTimeInfo("What's the weather today?");
  console.log("Needs live data:", needsLive);  // true

  // Perform web search (Brave Search API)
  if (needsLive && process.env.BRAVE_SEARCH_API_KEY) {
    const results = await search("OpenContext AI memory runtime", "web", 5);

    for (const result of results) {
      console.log(`- ${result.title}: ${result.url}`);
      console.log(`  ${result.description}`);
    }
  } else {
    console.log("Skipping live search: no BRAVE_SEARCH_API_KEY set");
  }
}

main().catch((error) => {
  console.error("Web search failed:", error);
  process.exit(1);
});
```

> Runnable examples:
> - `examples/src/tutorials/24-web-search-example.ts` — classify search intent and call Brave Search.
> - `examples/src/tutorials/33-search-example.ts` — `needsRealTimeInfo` classification with assertions.

## Audit Logging

OpenContext writes structured audit logs to `~/.opencontext/logs/audit.jsonl`. The audit helpers are re-exported from `@melandlabs/opencontext`.

```typescript
// audit-logging-example.ts
// Run with: npx tsx audit-logging-example.ts
import { logCommandExec, logFileRead, readAuditLogs } from "@melandlabs/opencontext";

async function main() {
  logFileRead("/etc/passwd");
  logCommandExec("git", ["status"]);

  const { entries, total } = readAuditLogs({ type: "file_read", limit: 10 });
  console.log(`Total audit entries: ${total}`);
  for (const entry of entries) {
    console.log(`[${entry.type}] ${entry.detail}`);
  }
}

main().catch((error) => {
  console.error("Audit logging example failed:", error);
  process.exit(1);
});
```

Parse the audit log from the shell:

```bash
# View recent audit entries
tail -f ~/.opencontext/logs/audit.jsonl | jq

# Count file-read entries
cat ~/.opencontext/logs/audit.jsonl | jq -r 'select(.type=="file_read") | .detail' | sort | uniq -c
```

> Runnable examples:
> - `examples/src/tutorials/25-audit-logging-example.ts` — write and read audit log entries.
> - `examples/src/tutorials/28-audit-example.ts` — structured audit-log surface checks with assertions.

## Performance Optimization

### Batch Operations

```typescript
// batch-store-example.ts
// Run with: npx tsx batch-store-example.ts
import { getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  const messages = await getRawMessageManager();
  const now = Date.now();

  // Batch store is much faster than individual calls.
  const batch = Array.from({ length: 1000 }, (_, i) => ({
    messageId: `msg-${now}-${i}`,
    userId: "user-123",
    content: `Message ${i}`,
    platform: "test",
    botId: "test-bot",
    timestamp: now,
    createdAt: now,
  }));

  const start = Date.now();
  const ids = await messages.storeMessages(batch);
  console.log(`Stored ${ids.length} message(s) in ${Date.now() - start}ms`);
}

main().catch((error) => {
  console.error("Batch store failed:", error);
  process.exit(1);
});
```

> Runnable example: `examples/src/tutorials/13-batch-example.ts`

### Embedding Caching

Avoid recomputing embeddings for repeated text by caching them. A `Map` works for short-lived processes; for production, swap in `lru-cache` or a shared cache store.

```typescript
// embedding-cache-example.ts
// Run with: npx tsx embedding-cache-example.ts
import { LocalTransformersEmbeddingProvider } from "@melandlabs/opencontext";

const embeddingCache = new Map<string, number[]>();

async function getCachedEmbedding(text: string) {
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const provider = new LocalTransformersEmbeddingProvider({
    model: "Xenova/all-MiniLM-L6-v2",
  });
  const embedding = await provider.embedQuery({ query: text });
  embeddingCache.set(text, embedding);
  return embedding;
}

async function main() {
  const text = "User prefers dark mode";

  const first = await getCachedEmbedding(text);
  console.log("First embedding dimensions:", first.length);

  const second = await getCachedEmbedding(text);
  console.log("Cache hit, same embedding:", first === second);
}

main().catch((error) => {
  console.error("Embedding cache example failed:", error);
  process.exit(1);
});
```

> Runnable examples:
> - `examples/src/tutorials/07-local-embeddings-example.ts` — generate embeddings locally.
> - `examples/src/tutorials/08-local-embeddings-full-setup.ts` — full local embedding + vector store setup.

### Connection Pooling (Postgres)

When using the Postgres backend for raw-message storage, configure a connection pool with `postgres` + `drizzle-orm`. These are not bundled with `@melandlabs/opencontext`, so install them separately.

```typescript
// postgres-pool-example.ts
// Run with: DATABASE_URL=postgres://... npx tsx postgres-pool-example.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  // Connection pool for Postgres
  const client = postgres(databaseUrl, {
    max: 10,            // Max connections
    idle_timeout: 20,
    connect_timeout: 10,
  });

  const db = drizzle(client, { logger: true });

  // Example: run a lightweight query to verify connectivity.
  const result = await db.execute("SELECT 1 as ok");
  console.log("Connected:", result);

  await client.end();
}

main().catch((error) => {
  console.error("Postgres pool example failed:", error);
  process.exit(1);
});
```

> Runnable examples:
> - `examples/src/tutorials/35-db-example.ts` — `batchInsert`, password hashing, and dummy-password generation.
> - `examples/src/tutorials/36-sqlite-example.ts` — SQLite raw-message storage and BM25 lexical search.

### Agent Runtimes

OpenContext exposes provider-agnostic agent primitives. You can drive Claude Code or OpenAI Codex CLI through the same `IAgent` lifecycle:

- `examples/src/tutorials/26-claude-agent-example.ts` — run and plan with `ClaudeAgent`.
- `examples/src/tutorials/27-codex-agent-example.ts` — run and plan with `CodexAgent` in a read-only sandbox.

### Memory Consolidation

For LLM-free memory planning, use the pure utilities in `@melandlabs/memory-consolidation` to cluster evidence, discover relation candidates, and build a consolidation plan:

- `examples/src/tutorials/37-memory-consolidation-example.ts`

### Generic HTTP Client

The `@melandlabs/api` package provides typed `get`/`post` helpers and `ApiError`:

- `examples/src/tutorials/34-api-example.ts`

### Environment Mode Detection

Detect Tauri vs server mode and read canonical defaults:

- `examples/src/tutorials/30-env-config-example.ts`

## Monitoring

### Health Checks

```bash
# Check all subsystems
npx @melandlabs/opencontext doctor

# Check specific subsystems
npx @melandlabs/opencontext doctor --section memory-store
npx @melandlabs/opencontext doctor --section embedding
npx @melandlabs/opencontext doctor --section integrations

# JSON output for monitoring
npx @melandlabs/opencontext doctor --json | jq '.ok'
```

### Metrics

Track OpenContext usage in your own counters:

```typescript
// metrics-example.ts
// Run with: npx tsx metrics-example.ts
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

const metrics = {
  memoryWrites: 0,
  memoryRecalls: 0,
};

async function trackedRemember(userId: string, content: string) {
  const manager = await getRawMessageManager();
  metrics.memoryWrites++;
  await manager.storeMessages([{
    messageId: `msg-${Date.now()}`,
    userId,
    content,
    platform: "tracked",
    botId: "metrics-bot",
    timestamp: Date.now(),
    createdAt: Date.now(),
  }]);
}

async function trackedRecall(userId: string, query: string) {
  const store = await createMemoryStore();
  metrics.memoryRecalls++;
  const results = await store.search({ userId, query, limit: 5 });
  await store.raw.close();
  return results;
}

async function main() {
  await trackedRemember("user-123", "User prefers TypeScript");
  const results = await trackedRecall("user-123", "What does the user prefer?");

  console.log("Metrics:", metrics);
  console.log(`Recalled ${results.count} result(s)`);

  // In a long-running process you might log metrics periodically:
  // setInterval(() => console.log("Metrics:", metrics), 60000);
}

main().catch((error) => {
  console.error("Metrics example failed:", error);
  process.exit(1);
});
```

## DeepSeek Harness Plugin

The [`dsh-opencontext`](https://github.com/melandlabs/opencontext/tree/main/plugins/dsh-opencontext) plugin gives DeepSeek Harness (DSH) agents persistent memory and retrieval-augmented generation capabilities by integrating with OpenContext.

### Prerequisites

- [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) installed
- Node.js >= 22.19.0 or >= 24.0.0

### Installation

#### From npm (recommended)

```bash
# Install directly from npm
dsh plugin --profile web add dsh-opencontext

# Start DSH Web
dsh web
```

#### From source (for development)

```bash
# Clone the repo and navigate to the plugin directory
cd plugins/dsh-opencontext

# Build the plugin
pnpm install
pnpm build

# Register with your DSH profile
dsh plugin --profile web add /path/to/opencontext/plugins/dsh-opencontext

# Start DSH Web
dsh web
# Visit http://127.0.0.1:3080/plugins to confirm the plugin is enabled
```

### Available Tools (16)

**Core Memory Tools (8)**

| Tool | Purpose |
|---|---|
| `oc_search` | Search long-term memory (unified across memory, insights, knowledge) |
| `oc_remember` | Persist one memory entry |
| `oc_memory_list` | List recent memory entries in current scope |
| `oc_memory_get` | Read one or more entries by ID |
| `oc_memory_revise` | Soft-deprecate an entry and store a successor |
| `oc_memory_retire` | Soft-deprecate an entry |
| `oc_prepare_context` | Manually build a bounded context block |
| `oc_capture_source` | Capture an arbitrary content source |

**Summary & Outcome Tools (3)**

| Tool | Purpose |
|---|---|
| `oc_session_summary` | Generate and store a session summary |
| `oc_task_outcome` | Record task outcomes, decisions, achievements |
| `oc_recent_summaries` | List recent session summaries and task outcomes |

**Insights Tools (2)**

| Tool | Purpose |
|---|---|
| `oc_insights_search` | Search structured insights (decisions, preferences, outcomes) |
| `oc_insight_capture` | Capture a structured insight from conversation |

**Knowledge/RAG Tools (3)**

| Tool | Purpose |
|---|---|
| `oc_knowledge_search` | RAG search over uploaded documents |
| `oc_document_upload` | Upload documents to knowledge base |
| `oc_document_list` | List all documents in knowledge base |

### Automatic Features

**Recall Waterfall**: Before each turn, automatically searches relevant historical memories and injects them as context.

**Auto-Capture**: Each user message is automatically written to the memory store.

**Session Summarization**: Optional automatic summarization at turn boundaries.

### Doctor Command

```
/oc doctor
```

Returns plugin status, database path, memory count, and enabled features.

### Configuration Options

| Field | Default | Environment Variable |
|---|---|---|
| `capturePrompts` | `true` | `OPENCONTEXT_DSH_CAPTURE_PROMPTS` |
| `maxRecallItems` | `8` | `OPENCONTEXT_DSH_MAX_RECALL_ITEMS` |
| `autoSummarize` | `false` | `OPENCONTEXT_DSH_AUTO_SUMMARIZE` |
| `captureToolResults` | `false` | `OPENCONTEXT_DSH_CAPTURE_TOOL_RESULTS` |
| `enableInsights` | `true` | `OPENCONTEXT_DSH_ENABLE_INSIGHTS` |
| `enableKnowledge` | `true` | `OPENCONTEXT_DSH_ENABLE_KNOWLEDGE` |

### Usage Examples

> **User**: I prefer TypeScript, remember that
> **Agent**: Got it, I'll remember that.
>
> *(Next conversation)*
> **User**: Write me a function
> **Agent**: I remember you prefer TypeScript. Here's a TS version...

> **User**: Upload my API docs
> **Agent**: *(uses oc_document_upload)* Done.
> **User**: How do I call this API?
> **Agent**: *(uses oc_knowledge_search)* According to your docs, the API is called like...

### Trust Model

Recalled memories are appended as **untrusted historical evidence**. If they contradict the user's current statement, the user always takes precedence.

## Complete Advanced Example Index

All runnable examples referenced in this guide:

| Example | Topic |
|---|---|
| `examples/src/tutorials/00-hello-memory-example.ts` | Store and search a first memory |
| `examples/src/tutorials/01-remember-example.ts` | Store a fact with metadata |
| `examples/src/tutorials/02-recall-example.ts` | Search unified memory across sources |
| `examples/src/tutorials/03-forget-example.ts` | Archive a message |
| `examples/src/tutorials/04-improve-example.ts` | Deprecate and supersede a fact |
| `examples/src/tutorials/05-time-travel-example.ts` | Time-travel / `asOf` queries |
| `examples/src/tutorials/06-minimal-config-example.ts` | Minimal SQLite-vec backend setup |
| `examples/src/tutorials/07-local-embeddings-example.ts` | Local embedding generation |
| `examples/src/tutorials/08-local-embeddings-full-setup.ts` | Full local embedding + vector-store setup |
| `examples/src/tutorials/09-http-client-example.ts` | HTTP client for the memory HTTP server |
| `examples/src/tutorials/10-reasoning-memory-example.ts` | Reasoning-backed retrieval + date-range filtering |
| `examples/src/tutorials/11-loop-example.ts` | Loop engine preferences |
| `examples/src/tutorials/12-integration-ids-example.ts` | List supported integration IDs |
| `examples/src/tutorials/13-batch-example.ts` | Batch memory writes |
| `examples/src/tutorials/17-memory-service.ts` | Reusable memory service wrapper |
| `examples/src/tutorials/18-remember-everything-example.ts` | Ingest incoming platform messages |
| `examples/src/tutorials/19-warning-handling-example.ts` | Inspect search warnings |
| `examples/src/tutorials/20-metadata-example.ts` | Store structured metadata with a fact |
| `examples/src/tutorials/21-scheduled-tasks-example.ts` | Cron next-run computation |
| `examples/src/tutorials/22-token-encryption-example.ts` | Token encryption / decryption |
| `examples/src/tutorials/23-url-validation-example.ts` | SSRF URL validation |
| `examples/src/tutorials/24-web-search-example.ts` | Web search with Brave |
| `examples/src/tutorials/25-audit-logging-example.ts` | Structured audit logging |
| `examples/src/tutorials/26-claude-agent-example.ts` | ClaudeAgent `run`/`plan`/`execute` |
| `examples/src/tutorials/27-codex-agent-example.ts` | CodexAgent `run`/`plan` |
| `examples/src/tutorials/28-audit-example.ts` | Audit log surface checks |
| `examples/src/tutorials/29-cron-example.ts` | Cron validation, next-run, and due checks |
| `examples/src/tutorials/30-env-config-example.ts` | Tauri / server mode detection |
| `examples/src/tutorials/31-storage-example.ts` | Storage provider operations |
| `examples/src/tutorials/32-insights-example.ts` | Insight filtering and EventRank scoring |
| `examples/src/tutorials/33-search-example.ts` | Search-intent classification |
| `examples/src/tutorials/34-api-example.ts` | Typed HTTP client helpers |
| `examples/src/tutorials/35-db-example.ts` | `batchInsert`, password hashing |
| `examples/src/tutorials/36-sqlite-example.ts` | SQLite raw-message storage + BM25 search |
| `examples/src/tutorials/37-memory-consolidation-example.ts` | Evidence clustering and consolidation planning |
| `examples/src/tutorials/38-channels-example.ts` | Platform adapter error envelopes |
| `examples/src/tutorials/39-integrations-runtime-example.ts` | Integration runtime helpers |
| `examples/src/tutorials/40-contracts-example.ts` | User-type and integration-id guards |

For end-to-end use cases, see the examples linked from [Personal Memory Assistant](./use-cases/05-personal-memory-assistant.md), [Customer Support Agent](./use-cases/06-customer-support-agent.md), and [Research Knowledge Tracker](./use-cases/07-research-tracker.md).

## Next Steps

- 📖 [Getting Started](./00-getting-started.md) - Quick start
- 👤 [User Guide](./01-user-guide.md) - Core concepts
- 🔧 [Developer Guide](./02-developer-guide.md) - Integration
- 📚 [Best Practices](./04-best-practices.md) - Optimization

---

**Sources:**
- [ClickHelp - Best Practices for Creating Developer Documentation](https://clickhelp.com/clickhelp-technical-writing-blog/best-practices-for-creating-developer-documentation/)
- [UpGrad - Open Source Projects for Beginners](https://www.upgrad.com/blog/open-source-projects-for-beginners/)
