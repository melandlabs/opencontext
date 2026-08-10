# `@opencontext/db`

Building blocks shared between OpenContext runtime and UI sub-projects.

Phase 4 of the [runtime/UI split plan](../../docs/split-runtime-ui.md) — currently
ships only the dependency-free helpers extracted from `apps/web/lib/db`:

| Subpath                                           | Source                                               | Notes                                                                         |
| ------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| `@opencontext/db`                                 | barrel                                               | Re-exports the subpaths below                                                 |
| `@opencontext/db/batch`                           | `apps/web/lib/db/batch.ts`                           | `batchInsert`, `DB_INSERT_CHUNK_SIZE`                                         |
| `@opencontext/db/utils`                           | `apps/web/lib/db/utils.ts`                           | `generateHashedPassword`, `generateDummyPassword`                             |
| `@opencontext/db/agent-goal-runtime-schema-types` | `apps/web/lib/db/agent-goal-runtime-schema-types.ts` | Type aliases re-exporting `@opencontext/ai/agent/runtime-instructions` shapes |

The bigger pieces (`schema.ts`, `schema.pg.ts`, `schema-sqlite.ts`, `queries.ts`,
`adapters/*`) stay inside `apps/web/lib/db/` until a later phase — they pull in
`@/lib/env`, `drizzle-orm` table definitions, and the giant Postgres+SQLite
schema files, and we want to keep the first extraction small and low-risk.
