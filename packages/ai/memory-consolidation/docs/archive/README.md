# Archived Memory Consolidation Notes

These documents are kept for history only. They are **not** authoritative and
must not be used to derive scope, task order, phase numbering, or
implementation authorization.

The active authority set lives one directory up:

- [Requirements](../memory-graph-evolution-requirements.md)
- [Architecture](../memory-graph-evolution-architecture.md)
- [ADR index](../adr/README.md)
- [Execution plan](../memory-graph-evolution-execution-plan.md)
- [Current handoff](../HANDOFF.md)

| Archived document                                                  | Superseded by                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------- |
| [roadmap.md](./roadmap.md)                                         | Requirements (product intent) and the execution plan |
| [execution-plan.md](./execution-plan.md)                           | `memory-graph-evolution-execution-plan.md`           |
| [design-zh.md](./design-zh.md)                                     | Requirements and architecture                        |
| [relation-graph-prototype-zh.md](./relation-graph-prototype-zh.md) | Architecture                                         |
| [storage-schema.md](./storage-schema.md)                           | The shipped migrations and `schema.pg.ts`            |

`roadmap.md` additionally used its own `Phase 1`-`Phase 12` numbering for the
earlier semantic-draft pipeline. That numbering is unrelated to the current
`Phase 0`-`Phase 6` delivery phases and is a frequent source of confusion; the
execution plan is the only source for phase numbering.
