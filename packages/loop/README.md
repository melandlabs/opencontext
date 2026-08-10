# `@openloomi/loop`

Loop filesystem + CLI shim resolver shared between OpenLoomi runtime and UI sub-projects.

Phase 5 of the [runtime/UI split plan](../../docs/split-runtime-ui.md) — currently
ships only the leaf pieces of `apps/web/lib/loop` that have no DB / agent /
integration dependencies:

| Subpath                | Source                          | Notes                                              |
| ---------------------- | ------------------------------- | -------------------------------------------------- |
| `@openloomi/loop`      | barrel                          | Re-exports the subpaths below                      |
| `@openloomi/loop/paths`| `apps/web/lib/loop/paths.ts`    | `LOOP_HOME`, `LOOP_PATHS`, `ensureDirs`, `migrate` |
| `@openloomi/loop/cli-path` | `apps/web/lib/loop/cli-path.ts` | Resolves absolute path to the `loop-cli.mjs` shim |
| `@openloomi/loop/preferences` | `apps/web/lib/loop/preferences.ts` | `readPreferences`, `writePreferences` (depends on `@openloomi/loop/paths`) |

The bigger pieces (`store.ts`, `runner.ts`, `tick.ts`, `brief.ts`, `wrap.ts`,
`connectors.ts`, `composio-bridge.ts`, `composio-cli.ts`, `handlers.ts`,
`watcher.ts`, `server.ts`, `decision-lock.ts`, `quiet-modules.ts`, `notify.ts`,
`activation.ts`, `readiness.ts`, `connectors-pure.ts`, `dev-scenes.ts`,
`email-bursts.ts`, `github-notifications.ts`, `custom-channels.ts`,
`custom-types.ts`, `outcomes.ts`, `paths.ts`'s twin `parent-watch.ts`, the
`modules/` subfolder, …) stay inside `apps/web/lib/loop/` — they need the
on-disk snapshot store, the agent bridge, Composio, the Drizzle DB, and/or
the integrations runtime, all of which will move in later phases.
