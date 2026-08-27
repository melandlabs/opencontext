---
"@melandlabs/okf": minor
"@melandlabs/opencontext": minor
---

Add the `opencontext okf serve` subcommand and a browser-side viewer that renders the in-memory knowledge graph.

- `startOkfServe({ port?, host?, user?, bot?, platform?, from?, rawStore? })` boots a Hono app that exposes `GET /health`, `GET /api/graph` (a `WikiGraph` over `RawMessage[]` or a frozen `.md` directory), and `GET /viewer/` (an opencontext-original SPA at `packages/okf/src/viewer/`, with SRI-pinned `force-graph` / `marked` / `dompurify` / `mermaid` from `cdn.jsdelivr.net`).
- Two operating modes: `live` queries the memory store on every `/api/graph` request, `frozen` serves a previously-emitted knowledge package from disk. The CLI flag `--from=<dir>` toggles between them.
- Re-exports `startOkfServe` from the `@melandlabs/opencontext` facade so demos and downstream apps can pick it up through the same surface as the rest of the OKF bridge.
- New peer / dev dependency on `@hono/node-server` (^1.13.7).
- Docs: `packages/okf/docs/viewer.md` (end-to-end tour of `/viewer/`), `packages/okf/docs/serve-architecture.md` (Hono app layout, live vs. frozen, shutdown ordering), `packages/okf/docs/alloomi-graph.md` (Mermaid diagrams from a real DingTalk export ingested through `okf ingest`).
- Examples: `examples/src/simple/21-okf-serve.ts` (live + frozen demo), `examples/src/tutorials/43-okf-serve-live.ts` (end-to-end walkthrough with `OKF_KEEP_OPEN=1` to keep the viewer alive after printing the graph).
- Tests: 10 new in `packages/okf/src/serve.test.ts`, 8 new in `packages/okf/src/graph.test.ts` — total 132 / 132 passing.