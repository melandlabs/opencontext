---
"@melandlabs/okf": patch
"@melandlabs/shared": patch
---

Build the subpaths these packages already advertise. Both declared an
export whose target file no tsup entry ever produced:

- `@melandlabs/okf` → `./graph` → `dist/graph.{js,d.ts}`
- `@melandlabs/shared` → `./text-chunking` → `dist/text-chunking.js`

Nothing imports either subpath yet, so this never surfaced at runtime —
but every published tarball since those exports were added has promised
an entry point that resolves to a missing file. `okf/graph` in
particular is documented as public API in the package README.
