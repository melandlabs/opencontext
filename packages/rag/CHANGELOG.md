# @melandlabs/rag

## 0.2.1

### Patch Changes

- Release @melandlabs/opencontext 0.2.6 and publish updated workspace dependencies.
- Updated dependencies
  - @melandlabs/shared@0.2.1

## 0.1.5

### Patch Changes

- 0.1.5 — repair `SQLiteVecStore.addChunk` write path

  Three latent bugs in `SQLiteVecStore` made every `addChunk` call throw:

  1. **Lazy Drizzle init was never awaited.** The constructor scheduled
     `initDrizzle(schemaModule)` as a floating Promise, then `addChunk`
     used `this.drizzleDb` synchronously. The first `addChunk` call
     crashed with `Cannot read properties of undefined (reading 'insert')`
     and any later call raced against the still-pending import. The
     constructor now stores the init Promise on `this.drizzleReady` and
     every async write path `await`s `this.ensureDrizzle()` first.

  2. **`addChunk` inserted into `{}`.** The Drizzle call was
     `this.drizzleDb.insert({} as any)`, which passes an empty object
     where Drizzle expects a column proxy and crashes on `.values(...)`.
     It now resolves `this.schemaModule.ragChunks` — the host's actual
     `rag_chunks` Drizzle table — which the constructor stashes on
     `this.schemaModule`.

  3. **`ON CONFLICT(chunk_id) DO UPDATE` on `vec0` is not supported.**
     sqlite-vec's vec0 virtual tables don't ship an UPSERT, so the
     previous `addChunk` would throw `SqliteError: UPSERT not implemented
for virtual table "rag_chunks_vec"` on a chunk that was already
     written. We now `DELETE WHERE chunk_id = ?` (no-op on first insert)
     and then plain `INSERT`. The vector index is rebuilt from the
     deleted row + new row, which is the supported way to re-write a
     chunk_id in vec0.

## 0.1.4

### Patch Changes

- 1de8e1a: 0.1.3 — unified daemon flags for HTTP and MCP, plus runnable examples

  Both `opencontext http` and `opencontext mcp` now accept the same
  `--embedding-provider` / `--*-backend` flag surface as `@melandlabs/ai-rag`
  ships, so the four `unified.*` deps (`embedQuery`, `searchRawMessagesAnn`,
  `searchInsights`, `searchKnowledge`) can be wired from a single CLI. The
  default `opencontext mcp` bin is now backed by a real JSON-RPC handshake
  (initialize → notifications/initialized → tools/list → tools/call) with
  four memory tools: `memory.health`, `memory.searchUnified`,
  `memory.writeRawMessage`, `memory.getRawMessage`. The `mcp` server also
  honors `MEMORY_MCP_NAME` and `MEMORY_MCP_VERSION` env vars and a
  `--name` / `--version` flag pair.

  Added two runnable examples to `examples/` that exercise the new daemon
  surface end-to-end against the real sqlite-vec + LocalTransformers
  embedder:

  - `examples/src/demo/15-http-server.ts` — spawns the HTTP daemon, hits
    `/health`, writes a raw message, runs a `searchUnified` query, and
    asserts the only warnings are the expected
    `*_not_configured` for the unused sources.
  - `examples/src/demo/16-mcp-server.ts` — spawns the MCP daemon over
    stdio, drives the full JSON-RPC handshake, writes two raw messages
    with `embedOnInsert: true`, and asserts the unified search returns
    at least one memory hit with no spurious warnings.

  Top-level README and `examples/README.md` (English + Chinese) now
  describe the daemon configuration, the `embedOnInsert` HTTP write
  option, and how to wire the MCP server into Claude Desktop / Cursor.

  Also: switched a stdout-polluting `console.log` in
  `packages/sqlite/src/raw-message-manager.ts` to `console.error` so the
  MCP stdio transport stays a clean JSON-RPC stream.

- Updated dependencies [1de8e1a]
  - @melandlabs/shared@0.1.4
