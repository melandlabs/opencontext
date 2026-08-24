---
"@melandlabs/okf": patch
---

Break the OKF ↔ memory-store workspace cycle at the source level. `cli.ts` (and the matching integration test) now hand-write the `RawMessageStore` shape and indirect the `@melandlabs/memory-store` import through a string variable, so tsup DTS no longer resolves memory-store's `dist/*.d.ts` at OKF's emit time. CI drops the two-pass build in favour of a single `pnpm -r --filter './packages/**' build` — no more TS2307 DTS race between the two `tsup` runs.
