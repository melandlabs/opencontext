# `opencontext okf serve` — architecture

> Visual companion to the `okf serve` implementation. See `README.md`
> for the user-facing CLI surface and the live / frozen flag table.

---

## 1. Module / runtime view

```mermaid
flowchart TB
  subgraph Entry["Entry surface"]
    CLI["CLI<br/>opencontext okf serve --port=… --from=…"]
    LIB["Library API<br/>import { startOkfServe } from '@melandlabs/okf'"]
  end

  subgraph Dispatch["CLI dispatch · packages/okf/src/cli.ts"]
    PA["parseOkfArgs"]
    RS["runServe<br/>(SIGINT/SIGTERM handler)"]
    SO["startOkfServe"]
  end

  subgraph Server["HTTP server · packages/okf/src/serve.ts"]
    HONO["Hono app"]
    ROUTES["/health<br/>/api/graph<br/>/viewer/*<br/>/  →  302"]
    SERVE["@hono/node-server<br/>(127.0.0.1:4321 default)"]
    VD["resolveViewerDir()<br/>probes ./viewer, ../src/viewer"]
  end

  subgraph Adapter["WikiGraph adapter · packages/okf/src/graph.ts"]
    BGM["buildGraphFromMessages"]
    BGD["buildGraphFromDir"]
    RL["resolveLinks()<br/>(dedupe + O(N) backlink fill)"]
    SH["stripTitleHeading<br/>sanitizeTypeFolder<br/>resolveRelative"]
  end

  subgraph Codec["Codec · packages/okf/src/codec.ts"]
    RMO["rawMessageToOkf"]
    OTR["okfToRawMessage"]
  end

  subgraph Package["Package I/O · packages/okf/src/package.ts"]
    ROP["readOkfPackage<br/>(.md walker + YAML parse)"]
    WOP["writeOkfPackage"]
  end

  subgraph Sources["Data sources"]
    MS["memory store<br/>SQLite / Postgres<br/>queryMessages"]
    DIR["OKF package directory<br/>Reference/, Experience/, Opinion/, …"]
  end

  subgraph Viewer["opencontext viewer · packages/okf/src/viewer/"]
    HTML["index.html<br/>(CSP, opencontext branding)"]
    CJ["client.js + client-lib.js<br/>(opencontext original)"]
    CSS["styles.css<br/>(opencontext theme)"]
    LIC["THIRD_PARTY_LICENSES.md"]
    CDN["CDN: force-graph · marked · dompurify · mermaid"]
  end

  CLI --> PA --> RS --> SO
  LIB --> SO
  SO --> HONO --> ROUTES --> SERVE
  SO --> VD --> Viewer
  ROUTES -->|live| BGM
  ROUTES -->|frozen| BGD
  BGM --> RMO
  BGM --> MS
  BGD --> ROP
  BGD --> DIR
  ROP --> Codec
  RMO --> Codec
  BGM --> RL
  BGD --> RL
  RL --> SH
  HTML --> CJ --> CDN
  HTML --> CSS
```

**Why this shape:**

- `cli.ts` and `serve.ts` are siblings; the CLI is a thin wrapper that
  converts argv into `OkfServeOptions` and calls `startOkfServe`. A
  library user imports `startOkfServe` directly and skips the CLI
  entirely.
- The graph adapter has two entry points but shares one resolver
  (`resolveLinks`). The only real divergence is *where the rows come
  from*: `RawMessage[]` from the memory store, or `OkfDocument[]` from
  a directory walker.
- The opencontext viewer is a passive static asset; `serve.ts` resolves
  its on-disk location at startup and serves it under `/viewer/*`.
  The CDN libs (`force-graph`, `marked`, …) are still pinned to MIT /
  Apache-2.0 versions because the user explicitly deferred local
  vendoring of those (~600 KB) to a later PR.

---

## 2. Request lifecycle for `GET /api/graph`

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant H as Hono (serve.ts)
  participant S as startOkfServe handler
  participant G as graph.ts
  participant C as codec.ts
  participant M as memory store
  participant P as package.ts

  B->>H: GET /api/graph
  H->>S: dispatch
  alt live mode (no --from)
    S->>M: getManager()
    S->>M: queryMessages({userId?, botId?, platform?, limit:100_000})
    M-->>S: RawMessage[]
    S->>C: rawMessageToOkf(msg) for each row
    C-->>S: { document, body, title }
    S->>G: buildGraphFromMessages(rows)
    G->>G: resolveLinks(nodes)<br/>(dedupe + reverse-pass backlinks)
    G-->>S: WikiGraph
  else frozen mode (--from=<dir>)
    S->>P: readOkfPackage(dir)
    P->>P: walk *.md<br/>parse YAML front-matter
    P-->>S: { files: OkfPackageFile[] }
    S->>G: buildGraphFromDir(dir)
    G->>G: resolveLinks(nodes)
    G-->>S: WikiGraph
  end
  S-->>H: c.json(graph)
  H-->>B: 200 application/json
  B->>B: force-graph renders nodes / edges<br/>marked renders body markdown<br/>mermaid renders code-fence diagrams
```

---

## 3. `WikiGraph` data shape

```mermaid
classDiagram
  class WikiGraph {
    +string root
    +string generatedAt
    +string[] types
    +WikiNode[] nodes
    +WikiEdge[] edges
  }
  class WikiNode {
    +string id            // "<Type>/<slug>"
    +string title
    +string type          // Reference | Experience | Opinion | …
    +string description
    +string[] tags
    +string body
    +number size          // body.length
    +string[] links       // outgoing, resolved
    +string[] backlinks   // incoming, reverse-pass
  }
  class WikiEdge {
    +string source        // WikiNode.id
    +string target        // WikiNode.id
  }
  WikiGraph "1" *-- "many" WikiNode
  WikiGraph "1" *-- "many" WikiEdge
  WikiEdge ..> WikiNode : source / target
  WikiNode ..> WikiNode : links / backlinks
```

**Id convention** (defined in `packages/okf/src/graph.ts`):

| Source | `id` |
| --- | --- |
| live `RawMessage` (messageId `acronym`, type `Reference`) | `Reference/acronym` |
| frozen `Reference/acronym.md` on disk | `Reference/acronym` |
| cross-folder link `[x](../Opinion/y.md)` | resolves to `Opinion/y` |

`resolveLinks` walks every node body, extracts `[label](relative.md)`
targets, resolves them against the node's parent folder (handling
`./` / `../`), strips `.md`, and filters self-links + unknown
targets. Backlinks are filled in the same pass via a reverse write
into the target node — O(N) total, no O(N²) `Set.has` lookups.

---

## 4. Facade bundling caveat

`@melandlabs/opencontext` bundles `@melandlabs/okf` (including
`startOkfServe`) into a single ESM file. After bundling,
`import.meta.url` inside `serve.ts`'s `resolveViewerDir` points at
`<facade-dist>/`, not `<okf-dist>/`. The facade's `tsup.config.ts`
has an `onSuccess` hook that copies `packages/okf/src/viewer/` →
`<facade-dist>/viewer/`, so `resolveViewerDir`'s first probe still
finds the assets.

If you change viewer files in `packages/okf/src/viewer/`, re-run
the facade build to refresh the copy.
