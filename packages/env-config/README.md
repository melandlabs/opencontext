# `env-config`

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Dep-free env / deployment-mode / Tauri-path constants.

| Subpath                | Source                    | Notes                                        |
| ---------------------- | ------------------------- | -------------------------------------------- |
| `env-config`           | `src/index.ts`            | Re-exports the subpaths below                |
| `.../client-constants` | `src/client-constants.ts` | Client-safe env constants (no `node:` deps)  |
| `.../client-mode`      | `src/client-mode.ts`      | `isTauriMode()` / `isServerMode()` helpers   |
| `.../tauri-paths`      | `src/tauri-paths.ts`      | Server-side Tauri data-dir / db / logs paths |

`client-constants.ts` is browser-safe (no `node:` imports). `tauri-paths.ts`
is server-only.
