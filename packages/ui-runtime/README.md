# `@opencontext/ui-runtime`

UI-side runtime primitives that **statically** import `@tauri-apps/*`. Lives in
the UI sub-project (`ui/packages/ui-runtime/` after Phase 9). Other packages must
**not** import `@tauri-apps/*` directly — use this package instead.

| Subpath | Source | Notes |
|---|---|---|
| `@opencontext/ui-runtime` | `src/index.ts` | Re-exports the subpaths below |
| `.../platform/env` | `src/platform/env.ts` | `isClient`, `isTauri`, `isBrowser`, `getPlatformKind` |
| `.../platform/filesystem` | `src/platform/filesystem.ts` | `getFileSystem()` factory + interface types |
| `.../platform/adapters/tauri/filesystem` | `src/platform/adapters/tauri/filesystem.ts` | Tauri-backed `PlatformFileSystem` |
| `.../platform/adapters/browser/filesystem` | `src/platform/adapters/browser/filesystem.ts` | File-System-Access-API-backed `PlatformFileSystem` |

Extracted from `@opencontext/shared` in Phase 8 so `@opencontext/shared` no longer
statically depends on `@tauri-apps/*`.