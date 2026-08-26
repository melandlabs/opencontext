# `@melandlabs/okf`

OKF v0.2 (Open Knowledge Format) importer / exporter for OpenContext.

OKF is a Markdown-with-YAML-front-matter document format used to
interchange knowledge between opencontext and external wiki / note
tools (Obsidian, mkdocs, etc.). This package makes OKF a
first-class import / export format for the opencontext memory store:
external tools can **ingest** `.md` files, and opencontext facts can
**emit** a directory of `.md` files plus a `manifest.json` that other
tools can consume.

## Layout

- `src/frontmatter.ts` — parse / stringify / validate the YAML front-matter.
- `src/codec.ts` — `okfToRawMessage` / `rawMessageToOkf` and the field map.
- `src/package.ts` — read / write a Knowledge Package (a directory of `.md` + `manifest.json`).
- `src/graph.ts` — `buildGraphFromMessages` / `buildGraphFromDir` (subpath `@melandlabs/okf/graph`).
- `src/errors.ts` — `OkfError` + `OkfIssue` types.
- `src/cli.ts` — `opencontext okf ingest | emit | validate | inspect | serve`.
- `src/serve.ts` — `startOkfServe` (subpath `@melandlabs/okf/serve`).
- `src/http.ts` — Hono routes for the HTTP daemon.
- `src/mcp.ts` — MCP tools for the MCP daemon.
- `src/viewer/` — opencontext static viewer (HTML/CSS/JS, see `THIRD_PARTY_LICENSES.md` for the CDN libs it loads).

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
opencontext okf serve [--port=<n>] [--host=<addr>] [--from=<dir>] [--user=<id>] [--bot=<id>] [--platform=<p>]
```

`serve` boots a local HTTP server on the given port (default `4321`,
loopback-only by default). With no `--from`, it queries the memory
store on every request and serves a live graph; pass `--from=<dir>` to
serve a previously-emitted Knowledge Package directory in frozen mode.
The opencontext OKF viewer is hosted under `/viewer/` and the
graph is served at `/api/graph`. See "Viewer / Static assets" below
for the full surface, and [`docs/viewer.md`](./docs/viewer.md) for
an end-to-end tour (file layout, data flow, customising the theme).

## Viewer / Static assets

```
GET  /                  → 302 → /viewer/
GET  /viewer/           → opencontext index.html (with CSP)
GET  /viewer/client.js  → opencontext browser module
GET  /viewer/client-lib.js → opencontext browser module
GET  /viewer/styles.css → opencontext stylesheet
GET  /health            → { ok, mode: "live"|"frozen", port, ts }
GET  /api/graph         → WikiGraph JSON consumed by the viewer
```

Live mode refreshes on every `/api/graph` request — F5 in the browser
to see newly-added facts without restarting the server. The viewer
pulls `force-graph`, `marked`, `dompurify`, and `mermaid` from
`cdn.jsdelivr.net` (SRI-pinned) — they are not bundled into the npm
package. See `src/viewer/THIRD_PARTY_LICENSES.md` for upstream
attribution.

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
