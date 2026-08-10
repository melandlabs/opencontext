# `@opencontext/cron`

Scheduling primitives.

| Subpath                             | Notes                                         |
| ----------------------------------- | --------------------------------------------- |
| `@opencontext/cron`                 | Barrel — re-exports the subpaths below        |
| `@opencontext/cron/types`           | `ScheduleConfig`, `JobConfig`, `CronJob`, …   |
| `@opencontext/cron/scheduler`       | `computeNextRun`, `validateCronExpression`, … |
| `@opencontext/cron/stream-response` | `createJobExecutionStreamResponse` (SSE)      |

Pure functions only — no DB, insights, or integration dependencies.
