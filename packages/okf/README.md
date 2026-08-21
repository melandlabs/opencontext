# `@melandlabs/okf`

OKF v0.2 (Open Knowledge Format) importer / exporter for OpenContext.

OKF is a Markdown-with-YAML-front-matter document format used to
interchange knowledge between opencontext and external wiki / note
tools (openwiki, Obsidian, mkdocs, etc.). This package makes OKF a
first-class import / export format for the opencontext memory store:
external tools can **ingest** `.md` files, and opencontext facts can
**emit** a directory of `.md` files plus a `manifest.json` that other
tools can consume.

## Layout

- `src/frontmatter.ts` — parse / stringify / validate the YAML front-matter.
- `src/codec.ts` — `okfToRawMessage` / `rawMessageToOkf` and the field map.
- `src/package.ts` — read / write a Knowledge Package (a directory of `.md` + `manifest.json`).
- `src/errors.ts` — `OkfError` + `OkfIssue` types.
- `src/cli.ts` — `opencontext okf ingest | emit | validate | inspect`.
- `src/http.ts` — Hono routes for the HTTP daemon.
- `src/mcp.ts` — MCP tools for the MCP daemon.

## Field mapping (summary)

| OKF field | RawMessage field |
| --- | --- |
| `resource` | `messageId` (slug-ified) |
| `generated.at` (ISO 8601) | `timestamp` (ms) |
| `generated.by` | `metadata.okfGenerator` |
| `title` + body | `content` |
| `type` | `factType` (mapped to `world` / `experience` / `mental_model`) |
| `description` | `metadata.okfDescription` |
| `tags` | `metadata.okfTags` |
| `sources[].resource` | `metadata.okfSources[]` + first URL → `attachments[0].url` |
| `verified[].{by,at}` | `metadata.okfVerified[]` |
| `status: draft` | `metadata.okfDraft = true` |
| `status: deprecated` | `archivedAt = now`, `deprecationReason = "okf:deprecated"` |
| `stale_after` (ISO date) | `metadata.okfStaleAfter` |
| `supersedes` / `superseded_by` | `supersededBySummaryId` |
| `user_id` / `bot_id` / `platform` | `userId` / `botId` / `platform` |

Unknown front-matter fields — including any vendor-specific extension
flags a downstream emitter adds (e.g. a `provenance: generated`
provenance marker) — are preserved under `metadata.okfExtras` so a
round-trip is loss-free. The OKF codec does not lift non-standard
front-matter keys into first-class fields.

## CLI

```
opencontext okf ingest <dir> [--user=<id>] [--bot=<id>] [--platform=<p>] [--dry-run] [--continue-on-error] [--json]
opencontext okf emit --user=<id> [--bot=<id>] [--platform=<p>] [--since=<iso|ms>] [--until=<iso|ms>] [--types=<t1,t2,...>] [--include-archived] --output=<dir> [--package-name=<name>] [--json]
opencontext okf validate <dir> [--json]
opencontext okf inspect <file> [--json]
```

## HTTP

```
POST /v1/okf/import         { userId, botId?, platform?, document }
POST /v1/okf/import-batch   { userId, botId?, platform?, documents[] }
POST /v1/okf/export         { userId, botId?, platform?, since?, until?, types?, includeArchived? }
```

## MCP

```
memory.okfImport  { userId, botId?, platform?, document }
memory.okfExport  { userId, botId?, platform?, since?, until?, types?, includeArchived? }
```

## Full reference

See [docs/okf.md](./docs/okf.md) for the complete OKF v0.2 format
spec, every front-matter field documented individually, required
minimum validation, encoding rules, and full CLI/HTTP/MCP request /
response shapes.
