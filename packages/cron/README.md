# `@openloomi/cron`

Scheduling primitives shared between OpenLoomi runtime and UI sub-projects.

Phase 5 of the [runtime/UI split plan](../../docs/split-runtime-ui.md) — currently
ships only the leaf pieces of `apps/web/lib/cron` that have no DB / insights /
integration dependencies:

| Subpath                          | Source                                | Notes                                            |
| -------------------------------- | ------------------------------------- | ------------------------------------------------ |
| `@openloomi/cron`                | barrel                                | Re-exports the subpaths below                    |
| `@openloomi/cron/types`          | `apps/web/lib/cron/types.ts`          | `ScheduleConfig`, `JobConfig`, `CronJob`, …      |
| `@openloomi/cron/scheduler`      | `apps/web/lib/cron/scheduler.ts`      | `computeNextRun`, `validateCronExpression`, …    |
| `@openloomi/cron/stream-response`| `apps/web/lib/cron/stream-response.ts`| `createJobExecutionStreamResponse` (SSE)         |

The bigger pieces (`executor.ts`, `service.ts`, `local-scheduler.ts`,
`insight-maintenance.ts`, `notifications.ts`) stay inside `apps/web/lib/cron/`
until a later phase — they pull in `@/lib/db/queries`, `@/lib/insights/*`,
`@/lib/integrations/*`, and the loop pet bridge.
