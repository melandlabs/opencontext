---
"@melandlabs/workspace": patch
---

Index the chunks that still wait for a vector, so the pending-chunk question stops scanning the whole table.

The store is asked the same question over and over: *does this version still have a chunk without a vector?* The embedding queue asks it after every job it finishes, and the stalled-resource sweep asks it for every pending resource on every round. `workspace_chunks` was indexed on `(workspace_id)` and `(resource_id, version_id)` only — neither of which has `version_id` in front — so every answer was a full table scan, and the answer that matters most ("this version is fully embedded") is precisely the one that has to look at every row to reach.

**What changed**

- `workspace_chunks` gains `idx_workspace_chunks_version_pending`, a partial index on `(version_id, chunk_index)` over the rows where `embedding IS NULL`. It is partial on purpose: only the chunks that still wait for a vector are indexed, so the index stays small however large the table grows, and a chunk leaves the index as soon as its vector is written.
- Both backends get it — the SQLite schema bootstrap and the Postgres DDL — under the same name and the same definition, so a store that is moved between them keeps the same plan.
- The store contract gains `filterVersionsWithPendingChunks(versionIds)`: the pending-chunk question asked about many versions at once. It answers with the subset that is not done, in one statement (SQLite) or one round trip (Postgres) instead of one per version. A sweep that asks about a hundred pending resources now asks once.

**Effect**

On a 120k-chunk table whose versions are all fully embedded — the worst case, and the one the queue hits at the end of every job — the question goes from a 89 ms scan to an index lookup:

```
plan (before): SCAN workspace_chunks
plan (after):  SEARCH workspace_chunks USING INDEX idx_workspace_chunks_version_pending (version_id=?)
scan  per query: 89.33 ms
index per query:  0.00 ms
```

Building the index costs about 100 ms once, on a store that has not seen it before. Existing databases pick it up the next time the store is opened; nothing is rewritten and no row is touched.

**Testing**

`test/pending-chunk-index.test.ts` pins the index's existence, the query plan of both pending-chunk queries, the fact that a chunk leaves the index once its vector is written, and the batched query on both the SQLite and the Postgres side. `test/postgres-store.test.ts` checks the Postgres side carries the same index (gated on `WORKSPACE_POSTGRES_URL`).
