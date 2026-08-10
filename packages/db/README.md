# `db`

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Dependency-free building blocks for database work.

| Subpath                              | Notes                                                            |
| ------------------------------------ | ---------------------------------------------------------------- |
| `db`                                 | Barrel — re-exports the subpaths below                           |
| `db/batch`                           | `batchInsert`, `DB_INSERT_CHUNK_SIZE`                            |
| `db/utils`                           | `generateHashedPassword`, `generateDummyPassword`                |
| `db/agent-goal-runtime-schema-types` | Type aliases re-exporting `ai/agent/runtime-instructions` shapes |

No DB drivers, no `drizzle-orm` tables, no schema files — just helpers.
