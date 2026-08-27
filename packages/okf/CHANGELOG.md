# @melandlabs/okf

## 0.3.1

### Patch Changes

- a8d0826: Fix `feedOkfServe` losing the `this` binding when calling `storeMessages` on the memory-store manager. Previously the helper destructured the method off the manager and invoked the bare function, which made `SQLiteRawMessageManager.storeMessages` throw `TypeError: Cannot read properties of undefined (reading 'init')` the first time any test exercised it. Now uses `.call(manager, …)` so the original manager stays the receiver.

## 0.3.0

### Minor Changes

- 97b6f2f: Add the `opencontext okf serve` subcommand and a browser-side viewer that renders the in-memory knowledge graph.

  - `startOkfServe({ port?, host?, user?, bot?, platform?, from?, rawStore? })` boots a Hono app that exposes `GET /health`, `GET /api/graph` (a `WikiGraph` over `RawMessage[]` or a frozen `.md` directory), and `GET /viewer/` (an opencontext-original SPA at `packages/okf/src/viewer/`, with SRI-pinned `force-graph` / `marked` / `dompurify` / `mermaid` from `cdn.jsdelivr.net`).
  - Two operating modes: `live` queries the memory store on every `/api/graph` request, `frozen` serves a previously-emitted knowledge package from disk. The CLI flag `--from=<dir>` toggles between them.
  - Re-exports `startOkfServe` from the `@melandlabs/opencontext` facade so demos and downstream apps can pick it up through the same surface as the rest of the OKF bridge.
  - New peer / dev dependency on `@hono/node-server` (^1.13.7).
  - Docs: `packages/okf/docs/viewer.md` (end-to-end tour of `/viewer/`), `packages/okf/docs/serve-architecture.md` (Hono app layout, live vs. frozen, shutdown ordering), `packages/okf/docs/alloomi-graph.md` (Mermaid diagrams from a real DingTalk export ingested through `okf ingest`).
  - Examples: `examples/src/simple/21-okf-serve.ts` (live + frozen demo), `examples/src/tutorials/43-okf-serve-live.ts` (end-to-end walkthrough with `OKF_KEEP_OPEN=1` to keep the viewer alive after printing the graph).
  - Tests: 10 new in `packages/okf/src/serve.test.ts`, 8 new in `packages/okf/src/graph.test.ts` — total 132 / 132 passing.

## 0.2.1

### Patch Changes

- bbf2485: Break the OKF ↔ memory-store workspace cycle at the source level. `cli.ts` (and the matching integration test) now hand-write the `RawMessageStore` shape and indirect the `@melandlabs/memory-store` import through a string variable, so tsup DTS no longer resolves memory-store's `dist/*.d.ts` at OKF's emit time. CI drops the two-pass build in favour of a single `pnpm -r --filter './packages/**' build` — no more TS2307 DTS race between the two `tsup` runs.

## 0.2.0

### Minor Changes

- b86d8d0: This changeset ships OKF (Open Knowledge Format) v0.2 as a first-class
  import / export format for the opencontext memory store. The OKF spec
  itself is unchanged — what changes is the surface that bridges it to
  `RawMessage`.

  **What's new**

  - **`@melandlabs/okf`** — new package. Codec (`okfToRawMessage` /
    `rawMessageToOkf`), package I/O (`readOkfPackage` /
    `writeOkfPackage`), CLI (`startOkf({action: ingest | emit | validate |
inspect})`), HTTP (`registerOkfRoutes`), MCP (`registerOkfTools`).
    Round-trip semantics: the front-matter `resource` is honoured as the
    canonical `messageId`, so `emit → ingest` upserts in place rather
    than creating `-2` suffixed duplicates.
  - **`@melandlabs/contracts`** — adds `OkfFrontMatter`, `OkfDocument`,
    `OkfPackageManifest` schemas, the canonical `OKF_TYPES` set
    (`Reference`, `Concept`, `Experience`, `Episode`, `Opinion`,
    `MentalModel`, `Belief`), and `okfTypeToFactType` /
    `factTypeToOkfType` inverses. Front-matter is `.passthrough()` so
    vendor-specific extension flags survive the round-trip under
    `metadata.okfExtras` without being lifted into first-class fields.
  - **`@melandlabs/memory-store`** — the unified daemon now exposes
    `POST /v1/okf/import`, `POST /v1/okf/import-batch`,
    `POST /v1/okf/export`, `memory.okfImport`, `memory.okfExport`,
    re-using the same `OkfRunOptions.sink` so HTTP / MCP / CLI agree on
    the `issues[]` envelope.
  - **`@melandlabs/opencontext`** — `opencontext okf ingest | emit |
validate | inspect` subcommand, plus facade re-exports of the OKF
    surface so host apps don't reach into the subpackage.

  **Required front-matter**

  Blocking (`exit=1` regardless of `--continue-on-error`):

  - `type` present (`missing_type`)
  - `generated.at` present and parseable (`missing_generated_at`)
  - valid YAML inside a front-matter fence (`invalid_yaml` /
    `invalid_frontmatter`)
  - non-empty body (`empty_body`)

  Soft warnings (surfaced in `issues[]`, do not force non-zero exit):

  - `generated.by` absent (`missing_generated_by`)
  - `description`, `tags`, `sources`, `verified`, `stale_after`,
    `supersedes` / `superseded_by` absent

  `validate` agrees with `ingest`: a file is `valid: true` only when
  no blocking issue is present.

  **Backward compatibility**

  - New public surface is purely additive. Existing `RawMessage` /
    `FactType` consumers are unaffected.
  - `yaml@^2` is added to the runtime tree (transitive dep of
    `@melandlabs/okf`); `tsup` already keeps it external so the
    opencontext bundle doesn't grow.
  - The SQLite scope-conflict guard still fires when a re-ingest tries
    to land the same `messageId` under a different `userId` — that
    hasn't changed.

### Patch Changes

- Updated dependencies [b86d8d0]
  - @melandlabs/contracts@0.6.0
  - @melandlabs/indexeddb@0.5.8
