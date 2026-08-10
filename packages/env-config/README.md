# `@opencontext/env-config`

Dep-free env / deployment-mode / Tauri-path constants.

| Subpath                   | Source                    | Notes                                        |
| ------------------------- | ------------------------- | -------------------------------------------- |
| `@opencontext/env-config` | `src/index.ts`            | Re-exports the subpaths below                |
| `.../client-constants`    | `src/client-constants.ts` | Client-safe env constants (no `node:` deps)  |
| `.../client-mode`         | `src/client-mode.ts`      | `isTauriMode()` / `isServerMode()` helpers   |
| `.../tauri-paths`         | `src/tauri-paths.ts`      | Server-side Tauri data-dir / db / logs paths |

`client-constants.ts` is browser-safe (no `node:` imports). `tauri-paths.ts`
is server-only.
