# Tutorial examples from `docs/tutorials`

These are the runnable TypeScript cases extracted from the tutorial markdown files in
[`../../docs/tutorials`](../../docs/tutorials). They were executed against the published
`@melandlabs/opencontext` package in a standalone project and then moved here with notes.

## Running

From this repo's `examples` directory:

```bash
cd /Users/timi/codes/opencontext/examples
pnpm install
node --experimental-strip-types docs-tutorials/00-hello-memory.ts
```

Most files import from `@melandlabs/opencontext` only, so they work once the
`examples` workspace dependencies are installed.

`09-http-client-example.ts` needs a local HTTP server:

```bash
npx @melandlabs/opencontext http \
  --embedding-provider local \
  --memory-backend sqlite-vec \
  --host 127.0.0.1 --port 7421
```

Then in another shell:

```bash
node --experimental-strip-types docs-tutorials/09-http-client-example.ts
```

## Files

### Getting started (`00-getting-started.md`)

| File | What it shows | Status |
|------|---------------|--------|
| `00-hello-memory.ts` | Store a fact and recall it with `createMemoryStore` + `getRawMessageManager` | ✅ Works |
| `07-local-embeddings-example.ts` | SDK mode with `LocalTransformersEmbeddingProvider` | ⚠️ Runs, but semantic search currently returns 0 results. The ONNX model loads and embeddings are produced, yet the stored vector is not retrieved by `searchUnifiedMemory`. |
| `08-local-embeddings-full-setup.ts` | Full local setup pattern from the developer guide | ⚠️ Same as above — runs, returns 0 results. |
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
| `17-memory-service.ts` | Encapsulated `initMemory` / `rememberFact` / `recallFacts` service | ⚠️ Runs, but `recallFacts` returns 0. The tutorial pairs `createMemoryStore({ db: {...} })` with `getRawMessageManager()`, which do not appear to share the same DB in this version. Use the default `createMemoryStore()` config if you need store + manager to see the same data. |

### Advanced usage (`03-advanced-usage.md`)

| File | What it shows | Status |
|------|---------------|--------|
| `11-loop-example.ts` | `LOOP_PATHS`, `ensureDirs`, `readPreferences`, `writePreferences` | ✅ Works |
| `12-integration-ids-example.ts` | `INTEGRATION_IDS` constant | ✅ Works |
| `13-batch-example.ts` | Batch 100 writes in one `storeMessages` call | ✅ Works |
