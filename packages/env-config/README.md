# `@opencontext/env-config`

Dep-free env / deployment-mode / Tauri-path constants used by both the UI
(`apps/web`) and the runtime services (`packages/*` daemons). Will live in the
runtime sub-project (`runtime/packages/env-config/` after Phase 9).

| Subpath | Source | Notes |
|---|---|---|
| `@opencontext/env-config` | `src/index.ts` | Re-exports the subpaths below |
| `.../client-constants` | `src/client-constants.ts` | Client-safe env constants (no `node:` deps) |
| `.../client-mode` | `src/client-mode.ts` | `isTauriMode()` / `isServerMode()` helpers |
| `.../tauri-paths` | `src/tauri-paths.ts` | Server-side Tauri data-dir / db / logs paths |

Extracted from `apps/web/lib/env/` in Phase 8 to break the apps/web → runtime
coupling on environment constants. The server-only `constants.ts` and
`server-constants.ts` remain in `apps/web/lib/env/` for now — they pull in
`@/lib/db/utils` (for `DUMMY_PASSWORD`) and will move in a later phase once the
DB layer is daemonized.