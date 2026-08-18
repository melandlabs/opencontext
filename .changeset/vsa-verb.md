---
"@melandlabs/contracts": minor
"@melandlabs/sqlite": minor
"@melandlabs/memory-store": minor
"@melandlabs/vsa": minor
---

`@melandlabs/memory-store` ships a new `store.vsa` facade — Vector Symbolic Architecture recall as a sibling verb to `store.search`.

- **Why**: Semantic search returns top-K nearest neighbours by cosine similarity. VSA returns a single best-match from a closed vocabulary. The two surfaces are intentionally separate — folding both into one result shape would require a confusing union type and a fake `similarity` field that doesn't mean the same thing across sources.

- **Surface**: four verbs on `MemoryStore.vsa`:
  - `vsaStoreFact({ userId, roleLabel, roleVector, fillerLabel, fillerVector, dim, scopeTag?, botId? })` — persist a (role, filler) binding as a HRR pair. Returns `{ factId, createdAt }`.
  - `vsaRecall({ userId, roleLabel, roleVector, vocabulary, scopeTag?, botId?, maxFacts? })` — re-superpose stored facts, unbind by the requested role, cleanup against the vocabulary, return the best-match label + sorted score list.
  - `vsaListFacts({ userId, scopeTag?, botId?, limit? })` — read-side projection (vectors stripped). Useful for diagnostics and audit.
  - `vsaForget({ userId, factIds, reason? })` — soft-delete by id. Idempotent.

- **Storage**: backed by a new `vsa_facts` table in `@melandlabs/sqlite` (Float32 BLOBs for the vectors, idempotent `CREATE TABLE IF NOT EXISTS`). Shares the same SQLite DB as the raw-message manager; no separate migration step.

- **Persistence contract**: `VsaFactStorage` interface in `@melandlabs/contracts/vsa-fact` (`storeFact` / `queryFacts` / `deprecateFacts`). `SQLiteVsaStore` is the bundled implementation; hosts can register their own backend.

- **HTTP**: `POST /v1/vsa/store`, `POST /v1/vsa/recall`, `POST /v1/vsa/list`, `POST /v1/vsa/forget` on the daemon.

- **MCP**: `memory.vsaStore`, `memory.vsaRecall`, `memory.vsaList`, `memory.vsaForget` on the stdio server.

- **Workspace dependency**: `@melandlabs/memory-store` gains `workspace:*` on `@melandlabs/vsa`.

- **Capacity**: HRR superpositions tolerate noise gracefully but degrade as you approach √D stored facts (Plate, 1995). For `D = 128` that's roughly 11 facts before crosstalk dominates a single best-match cleanup. For dense recall (thousands of facts) use `D = 512` or `D = 1024`. The facade accepts whatever dimension you store; mismatches between facts with different `dim` values are surfaced as `vsa_dim_mismatch` warnings and dropped before superposition.