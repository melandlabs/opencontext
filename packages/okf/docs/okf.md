# OKF v0.2 — Open Knowledge Format

OpenContext uses OKF v0.2 (Open Knowledge Format) as a first-class
import / export format. OKF is a Markdown-with-YAML-front-matter
document format used to interchange knowledge between opencontext and
external wiki / note tools (Obsidian, mkdocs, etc.).

The front-matter metadata layer carries the same semantics that
opencontext's temporal context graph stores on `RawMessage` — facts
about *when* a concept was created, *who* generated it, *what* it
supersedes, and *who* verified it. That metadata rides alongside the
Markdown body so the document is fully self-describing.

## Format spec (v0.2)

An OKF document is a UTF-8 Markdown file with a leading YAML
front-matter block:

```yaml
---
type: Reference              # required
title: Project Acronym       # optional
description: OKF and its expansion
tags: [acronym, project]
status: draft | deprecated | active (default)
stale_after: 2027-01-01      # ISO 8601 date
generated:
  by: alice                  # required
  at: 2026-08-19T10:00:00Z   # required, ISO 8601
verified:
  - by: bob
    at: 2026-08-19T10:00:00Z
sources:
  - resource: https://example.com/spec
supersedes:                # front-matter link
  - Reference/older-foo
superseded_by: Reference/newer-foo
user_id: u-1                 # optional; CLI fallback also accepted
bot_id: okf-import
platform: okf
---

OKF = Open Knowledge Format.
```

Unknown front-matter keys are preserved verbatim and surfaced on the
ingested `RawMessage.metadata` as `okfExtras` so a round-trip is
loss-free.

### Canonical `type` values

| OKF type   | opencontext `FactType` |
|------------|------------------------|
| Reference  | `world`                |
| Concept    | `world`                |
| Experience | `experience`           |
| Episode    | `experience`           |
| Opinion    | `mental_model`         |
| MentalModel| `mental_model`         |
| Belief     | `mental_model`         |

Unknown types are still accepted on ingest and surfaced as
`metadata.okfType`; they map to `world` on the default `factType`.

## Field mapping (OKF ↔ RawMessage)

| OKF field | RawMessage field |
| --- | --- |
| `resource` | `messageId` (slug-ified, deduped with `-2`, `-3`, …) |
| `generated.at` (ISO 8601) | `timestamp` (ms) |
| `generated.by` | `metadata.okfGenerator` |
| `title` + body | `content` (`# title\n\nbody` when title is non-empty) |
| `type` | `factType` (via the table above) + `metadata.okfType` |
| `description` | `metadata.okfDescription` |
| `tags` | `metadata.okfTags` |
| `sources[].resource` | `metadata.okfSources[]` + first URL → `attachments[0].url` |
| `verified[].{by,at}` | `metadata.okfVerified[]` |
| `status: draft` | `metadata.okfDraft = true` |
| `status: deprecated` | `archivedAt = now`, `deprecationReason = "okf:deprecated"` |
| `stale_after` (ISO date) | `metadata.okfStaleAfter` |
| `superseded_by` | `supersededBySummaryId` (this record was replaced *by* the linked one) |
| `supersedes` | `metadata.okfSupersedes` (inverse link, round-tripped verbatim — kept off `supersededBySummaryId` so the direction is preserved) |
| `user_id` / `bot_id` / `platform` | `userId` / `botId` / `platform` (with CLI fallback) |
| unknown front-matter fields (e.g. vendor-specific provenance flags) | `metadata.okfExtras` |
| body markdown links `[..](path.md)` | `metadata.okfLinks[]` |

## Required minimum

A front-matter block must satisfy the **blocking** checks below to be
ingested or to pass `validate`. These are shared by the CLI, HTTP
(`/v1/okf/import`, `/v1/okf/import-batch`) and MCP (`memory.okfImport`)
surfaces — they all defer to the same `OKF_BLOCKING_ISSUE_CODES` set in
`codec.ts`, so every entry point agrees on what "required" means:

- `type` must be present (else `missing_type`)
- `generated.at` must be present and parseable (else `missing_generated_at`)
- the block must be valid YAML inside a front-matter fence (else
  `invalid_yaml` / `invalid_frontmatter`)
- the body must be non-empty (else `empty_body`)

`generated.by`, `description`, `tags`, `sources`, `verified`,
`stale_after` and `supersedes`/`superseded_by` are **optional** — when
absent they surface as soft warnings (`missing_generated_by`, …) in the
`issues[]` envelope but do NOT fail the operation or force a non-zero
exit code. `validate` reports all issues but only treats a document as
invalid when a blocking issue is present, so `ingest` and `validate`
agree on the same contract.

## CLI

```
opencontext okf ingest <dir>
    --user=<id>                  # fallback when front-matter lacks user_id (required)
    [--bot=<id>]                 # default "okf-import"
    [--platform=<p>]             # default "okf"
    [--dry-run]                  # parse + validate, do not ingest
    [--continue-on-error]        # collect issues per file instead of fail-fast
    [--json]                     # stable envelope { ok, exit, summary, issues[] }

opencontext okf emit --user=<id>
    [--bot=<id>]                 # filter: only this botId
    [--platform=<p>]             # filter: only this platform
    [--since=<iso|ms>]           # filter: timestamp >= since
    [--until=<iso|ms>]           # filter: timestamp <= until
    [--types=<t1,t2,...>]        # filter: only these OKF types (Reference, Opinion, ...)
    [--include-archived]         # include superseded/deprecated facts
    --output=<dir>               # required
    [--package-name=<name>]      # manifest.name override
    [--json]                     # stable envelope { ok, exit, written, path }

opencontext okf validate <dir>   [--json]
opencontext okf inspect <file>   [--json]
```

### Output

Human mode uses `✓/⚠/✗` glyphs and `[opencontext/okf]` log prefix on
stderr warnings. JSON mode emits a stable envelope:

```json
{ "ok": true, "exit": 0, "summary": { "ingested": 3, "skipped": 0, "issues": 0 }, "issues": [] }
```

Exit codes:

- `0` — success (no blocking validation failures)
- `1` — at least one validation failure or ingest error

### Knowledge Package

`okf emit` writes a directory of `<Type>/<slug>.md` files plus a
`manifest.json` that summarises the contents:

```json
{
  "schema": "okf/v0.2",
  "name": "opencontext-export-u-1-20260819",
  "generatedAt": "2026-08-19T10:00:00Z",
  "generatedBy": "opencontext@1.0.0",
  "okfConceptCount": 42,
  "okfTypeCounts": { "Reference": 30, "Experience": 10, "Opinion": 2 },
  "sources": ["memory-store"],
  "userIds": ["u-1"],
  "platforms": ["okf"],
  "files": ["Reference/foo.md", "Experience/bar.md"]
}
```

The manifest is optional on read (the reader infers counts from the
files present) but is always written on emit.

## HTTP

```
POST /v1/okf/import
    body: { userId, botId?, platform?, document: { resource?, frontMatter, body } }
    → 200 { ok: true, messageId, factType, indexed: true }
    → 400 { error, issues? }

POST /v1/okf/import-batch
    body: { userId, botId?, platform?, documents: [...] }
    → 200 { ok: true, count, results: [{ ok, messageId?, issues? }] }

POST /v1/okf/export
    body: { userId, botId?, platform?, since?, until?, types?, includeArchived? }
    → 200 { ok: true, count, documents: [...] }
```

The routes are registered on the same Hono app as the rest of the
memory-store HTTP daemon (`opencontext http`).

## MCP

```
memory.okfImport
    input: { userId, botId?, platform?, document: { resource?, frontMatter, body } }
    output: { content: [{ type: "text", text: JSON.stringify({ ok, messageId, factType, issues? }) }] }

memory.okfExport
    input: { userId, botId?, platform?, since?, until?, types?, includeArchived? }
    output: { content: [{ type: "text", text: JSON.stringify({ ok, count, documents }) }] }
```

These tools are registered on the same MCP server as the rest of
`opencontext mcp`.

## Programmatic API

```ts
import {
  parseOkf,
  okfToRawMessage,
  rawMessageToOkf,
  readOkfPackage,
  writeOkfPackage,
  OkfError,
} from "@melandlabs/okf";

// Parse and ingest a single document.
const { frontMatter, body } = parseOkf(text);
const { rawMessage, issues } = okfToRawMessage(
  { frontMatter, body },
  { userId: "u-1" },
);

// Emit a Knowledge Package.
const { manifest, written } = await writeOkfPackage("/tmp/out", messages, {
  packageVersion: "1.0.0",
});
```

## Round-trip guarantees

- `content`, `timestamp`, `factType`, `metadata.okfGenerator`,
  `metadata.okfTags`, `metadata.okfVerified`, `metadata.okfStaleAfter`,
  `metadata.okfDescription`, `metadata.okfType`, `userId`, `botId`,
  `platform` are preserved across ingest → emit → re-ingest.
- `status: deprecated` is *lossy* on re-ingest: the round-trip sets
  `archivedAt = now` (the originating OKF document has no MS-precision
  timestamp), so the second ingest will have a fresher `archivedAt`
  than the first. The `deprecationReason` field is preserved verbatim.
- The `metadata.okfExtras` round-trip preserves arbitrary unknown
  front-matter fields both ways (the emitter stashes them back at the
  top level on emit).

## See also

- [`serve-architecture.md`](./serve-architecture.md) — Hono app layout,
  WikiGraph adapter, live vs. frozen mode, shutdown ordering.
- [`viewer.md`](./viewer.md) — the `/viewer/` SPA: file layout, graph
  data flow, persisted UI state, theme customisation.
- [`alloomi-graph.md`](./alloomi-graph.md) — Mermaid diagrams rendered
  from a real DingTalk export ingested through `okf ingest`.
