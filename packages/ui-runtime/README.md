# `ui-runtime`

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


UI-side runtime primitives that statically import `@tauri-apps/*`. Other
packages must **not** import `@tauri-apps/*` directly — use this package
instead.

| Subpath                                    | Source                                        | Notes                                                 |
| ------------------------------------------ | --------------------------------------------- | ----------------------------------------------------- |
| `ui-runtime`                  | `src/index.ts`                                | Re-exports the subpaths below                         |
| `.../platform/env`                         | `src/platform/env.ts`                         | `isClient`, `isTauri`, `isBrowser`, `getPlatformKind` |
| `.../platform/filesystem`                  | `src/platform/filesystem.ts`                  | `getFileSystem()` factory + interface types           |
| `.../platform/adapters/tauri/filesystem`   | `src/platform/adapters/tauri/filesystem.ts`   | Tauri-backed `PlatformFileSystem`                     |
| `.../platform/adapters/browser/filesystem` | `src/platform/adapters/browser/filesystem.ts` | File-System-Access-API-backed `PlatformFileSystem`    |

`@tauri-apps/*` is declared as an optional peer dependency — bundlers that
target a non-Tauri host will tree-shake the Tauri adapters out.
