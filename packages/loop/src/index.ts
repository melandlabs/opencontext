// @opencontext/loop — leaf filesystems / preferences shared by runtime + UI
// See `docs/split-runtime-ui.md` for boundary contract.
//
// `paths` and `cli-path` are pure node:fs/path; `preferences` depends on
// `paths` and the LoopPreferences type alias (kept in apps/web for now).
// Files that need the on-disk snapshot store, agent bridge, or DB
// (`store.ts`, `runner.ts`, `tick.ts`, `brief.ts`, `wrap.ts`, `connectors.ts`,
// `composio-bridge.ts`, `composio-cli.ts`, `handlers.ts`, `watcher.ts`, …)
// stay inside `apps/web/lib/loop/` for now and will move once the bigger
// boundary is settled.

export * from "./paths";
export * from "./cli-path";
export { readPreferences, writePreferences } from "./preferences";
