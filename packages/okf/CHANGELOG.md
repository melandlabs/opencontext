# @melandlabs/okf

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
