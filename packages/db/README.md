# `@opencontext/db`

Dependency-free building blocks for database work.

| Subpath                                           | Notes                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `@opencontext/db`                                 | Barrel — re-exports the subpaths below                                        |
| `@opencontext/db/batch`                           | `batchInsert`, `DB_INSERT_CHUNK_SIZE`                                         |
| `@opencontext/db/utils`                           | `generateHashedPassword`, `generateDummyPassword`                             |
| `@opencontext/db/agent-goal-runtime-schema-types` | Type aliases re-exporting `@opencontext/ai/agent/runtime-instructions` shapes |

No DB drivers, no `drizzle-orm` tables, no schema files — just helpers.
