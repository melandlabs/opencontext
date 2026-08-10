// @melandlabs/loop — leaf filesystem / preferences primitives.
//
// `paths` and `cli-path` are pure node:fs/path; `preferences` depends on
// `paths`. Files that need the on-disk snapshot store, agent bridge, or DB
// (`store.ts`, `runner.ts`, `tick.ts`, `brief.ts`, `wrap.ts`, `connectors.ts`,
// `composio-bridge.ts`, `composio-cli.ts`, `handlers.ts`, `watcher.ts`, …)
// live in the host application — they pull in dependencies that don't
// belong in a leaf package.

export * from "./paths";
export * from "./cli-path";
export { readPreferences, writePreferences } from "./preferences";
