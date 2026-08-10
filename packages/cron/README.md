# `cron`

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Scheduling primitives.

| Subpath                | Notes                                         |
| ---------------------- | --------------------------------------------- |
| `cron`                 | Barrel — re-exports the subpaths below        |
| `cron/types`           | `ScheduleConfig`, `JobConfig`, `CronJob`, …   |
| `cron/scheduler`       | `computeNextRun`, `validateCronExpression`, … |
| `cron/stream-response` | `createJobExecutionStreamResponse` (SSE)      |

Pure functions only — no DB, insights, or integration dependencies.
