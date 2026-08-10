# `loop`

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Filesystem layout + CLI shim resolver for the Loop engine.

| Subpath            | Notes                                                           |
| ------------------ | --------------------------------------------------------------- |
| `loop`             | Barrel — re-exports the subpaths below                          |
| `loop/paths`       | `LOOP_HOME`, `LOOP_PATHS`, `ensureDirs`, `migrate`              |
| `loop/cli-path`    | Resolves absolute path to the `loop-cli.mjs` shim               |
| `loop/preferences` | `readPreferences`, `writePreferences` (depends on `loop/paths`) |

Production location: `~/.opencontext/loop/` — see
[`paths.ts`](./src/paths.ts) for the full layout.

## CLI shim resolution

`resolveLoopCli()` (in [`cli-path.ts`](./src/cli-path.ts)) walks a small set
of candidate locations in this order:

1. `OPENCONTEXT_LOOP_CLI` env var
2. `~/.opencontext/runtime/loop-cli.mjs` (packaged desktop bundle)
3. `.next/standalone/apps/...` (Tauri staging)
4. `apps/.../scripts/loop-cli.mjs` (dev workspace)

Returns `null` when nothing matches — callers should treat that as a soft
error and surface it in their tick log.

## Migration

The `migrate()` helper in `paths.ts` runs once on first boot and copies
data out of a legacy skill folder into `~/.opencontext/loop/`. It is
idempotent and never deletes source files.
