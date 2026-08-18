# Tutorial examples from `docs/tutorials`

These are the runnable TypeScript cases extracted from the tutorial markdown files in
[`../../docs/tutorials`](../../docs/tutorials). They were executed against the local
`@melandlabs/opencontext` workspace package.

## Running

From this repo's `examples` directory:

```bash
cd /path/to/opencontext/examples
pnpm install
node --experimental-strip-types src/tutorials/00-hello-memory.ts
```

Most files import from `@melandlabs/opencontext` only, so they work once the
`examples` workspace dependencies are installed.

## Files

### Getting started (`00-getting-started.md`)

| File | What it shows | Status |
|------|---------------|--------|
| `00-hello-memory.ts` | Store a fact and recall it with `createMemoryStore` + `getRawMessageManager` | ✅ Works |
| `07-local-embeddings-example.ts` | SDK mode with `LocalTransformersEmbeddingProvider` | ✅ Works |
| `08-local-embeddings-full-setup.ts` | Full local setup pattern from the developer guide | ✅ Works (returns 0 results because it only configures the store) |
| `10-reasoning-memory-example.ts` | Reasoning-backed retrieval (`rewrite` / `iterative`) | ✅ Works when `OPENCONTEXT_LLM_API_KEY` is set |
| `09-http-client-example.ts` | HTTP client talking to `opencontext http` | ✅ Works when the server is running. |

### User guide (`01-user-guide.md`)

| File | What it shows | Status |
|------|---------------|--------|
| `01-remember-example.ts` | Store a `RawMessage` with metadata | ✅ Works |
| `02-recall-example.ts` | `searchUnifiedMemory` with sources / threshold / botIds | ✅ Works |
| `03-forget-example.ts` | `archiveMessages` soft-delete | ✅ Works |
| `04-improve-example.ts` | Store a correction and `deprecateMessages` the old fact | ✅ Works |
| `05-time-travel-example.ts` | `asOf` time-travel query | ✅ Works |
| `18-remember-everything-example.ts` | Ingest any incoming message shape | ✅ Works |
| `19-warning-handling-example.ts` | Inspect `results.warnings` | ✅ Works |
| `20-metadata-example.ts` | Store structured metadata alongside a fact | ✅ Works |

### Developer guide (`02-developer-guide.md`)

| File | What it shows | Status |
|------|---------------|--------|
| `06-minimal-config-example.ts` | Local-only SQLite configuration | ✅ Works |
| `17-memory-service.ts` | Encapsulated `initMemory` / `rememberFact` / `recallFacts` service | ✅ Works |

### Advanced usage (`03-advanced-usage.md`)

| File | What it shows | Status |
|------|---------------|--------|
| `11-loop-example.ts` | `LOOP_PATHS`, `ensureDirs`, `readPreferences`, `writePreferences` | ✅ Works |
| `12-integration-ids-example.ts` | `INTEGRATION_IDS` constant | ✅ Works |
| `13-batch-example.ts` | Batch 100 writes in one `storeMessages` call | ✅ Works |
| `21-scheduled-tasks-example.ts` | `validateCronExpression` and `computeNextRun` | ✅ Works |
| `22-token-encryption-example.ts` | `TokenEncryption.encryptToken` / `decryptToken` | ✅ Works with `ENCRYPTION_KEY` |
| `23-url-validation-example.ts` | `validateUrlForSSRF` and `isTrustedStorageUrl` | ✅ Works |
| `24-web-search-example.ts` | `needsRealTimeInfo` and `search` | ✅ Works (skips search without `BRAVE_SEARCH_API_KEY`) |
| `25-audit-logging-example.ts` | `logFileRead`, `logCommandExec`, `readAuditLogs` | ✅ Works |

### Real-World Use Cases

| File | What it shows | Status |
|------|---------------|--------|
| `use-cases/30-personal-memory-assistant.ts` | Personal assistant with preferences, notes, time-travel, metadata | ✅ Works |
| `use-cases/31-customer-support-agent.ts` | Multi-user support agent with customer history, repeat detection, batch import | ✅ Works |
| `use-cases/32-research-knowledge-tracker.ts` | Research tracker with findings, citations, evolution tracking, synthesis | ✅ Works |

### Reflection & write-back (folded into [`03-advanced-usage.md` → Reflection and Write-Back](../../docs/tutorials/03-advanced-usage.md#reflection-and-write-back))

| File | What it shows | Status |
|------|---------------|--------|
| `41-reflect-writeback-example.ts` | `store.reflect()` (read-only) + `store.reflectWithPlan({ dryRun })` (agentic write-back) end-to-end loop with a deterministic mock LLM | ✅ Works |
| `42-facttype-filter-example.ts` | Classify raw messages as `world` / `experience` / `mental_model`; narrow recall with the `factTypes` filter | ✅ Works |
