# Alloomi dingtalk-export → OKF graph

> Real run output from `startOkfServe --from=<injected bundle>`.
> Generated 2026-08-26 against the bundle at
> `/Users/timi/Downloads/Alloomi数字员工引导流程/`.

## Input pipeline

The dingtalk-export bundle has no OKF front-matter. `readOkfPackage`
walks the `.md` files but every document falls back to `type=Reference`
with no tags / description. To exercise the graph adapter meaningfully
we ran a one-shot injector (`/tmp/okf-inject.mjs`) that:

- classifies `15 / 16 【PRD】*` documents as `Concept`
- classifies `*设计方案* / *详情页*` documents as `Reference`
- derives `title` from the first `# heading` line, `description` from
  the first paragraph
- emits `tags` from filename heuristics (`prd`, `design-spec`, `overview`,
  `knowledge-base`, `detail-page`)
- wires `superseded_by` between hash-suffixed re-uploads and their
  canonical twin (`-12b53192`, `-7708b37f`, `-9eacf632` are all re-uploads)

The injector writes to a parallel `/tmp/okf-injected-*` tree; the
user's source files are untouched.

## Real `GET /api/graph` output

```jsonc
{
  "root": "okf-injected-1787748328584",
  "types": ["Concept", "Reference"],
  "nodes": 8,
  "edges": 0
}
```

The 8 nodes, grouped by type and tags (rendered exactly as the graph
adapter emits them — no edges because the source docs do not cross-link):

```mermaid
flowchart LR
  classDef concept fill:#fef3c7,stroke:#b45309,color:#1f2937
  classDef reference fill:#dbeafe,stroke:#1d4ed8,color:#1f2937

  subgraph Concept["Concept · 4"]
    c1["<b>15 【PRD】Alloomi支持项目实体</b><br/>type=Concept · tags=[prd]<br/>size=6255"]:::concept
    c2["<b>15 【PRD】Alloomi支持项目实体-12b53192</b><br/>type=Concept · tags=[prd]<br/>size=6255 · superseded_by c1"]:::concept
    c3["<b>15 【PRD】Alloomi支持项目实体-7708b37f</b><br/>type=Concept · tags=[prd]<br/>size=17127 · superseded_by c1"]:::concept
    c4["<b>16 【PRD】Alloomi 知识库</b><br/>type=Concept · tags=[prd, knowledge-base]<br/>size=9997"]:::concept
  end

  subgraph Reference["Reference · 4"]
    r1["<b>Alloomi 项目设计方案</b><br/>type=Reference · tags=[design-spec]<br/>size=6485"]:::reference
    r2["<b>Alloomi 项目详情页设计方案</b><br/>type=Reference · tags=[design-spec, detail-page]<br/>size=9895"]:::reference
    r3["<b>Alloomi 项目概览设计方案</b><br/>type=Reference · tags=[design-spec, overview]<br/>size=6572"]:::reference
    r4["<b>Alloomi 项目概览设计方案-9eacf632</b><br/>type=Reference · tags=[design-spec, overview]<br/>size=6572 · superseded_by r3"]:::reference
  end
```

**`edges=0`** is correct: the source documents use dingtalk's numbered
PRDs (`15` / `16`) and design-spec filenames for cross-referencing,
not markdown links. The graph adapter only resolves `[label](target.md)`
edges (per `packages/okf/src/graph.ts:resolveLinks`), so it correctly
emits an empty edge list. If you want the graph to surface supersedes
or topic-cluster edges, the front-matter needs to declare them as
`supersedes: [c2]` (and `graph.ts` needs a `resolveFrontMatterEdges`
pass) — not in scope for `okf graph` today.

## Conceptual supersedes graph (front-matter, not yet in `buildGraphFromDir`)

The injector wired `superseded_by` for the three hash-suffixed re-uploads.
This is real front-matter data the graph adapter doesn't yet render.
Here's what the bundle's *intended* structure looks like:

```mermaid
flowchart LR
  classDef canonical fill:#dcfce7,stroke:#15803d,color:#1f2937
  classDef superseded fill:#f3f4f6,stroke:#9ca3af,color:#6b7280

  c1["<b>15 【PRD】Alloomi支持项目实体</b><br/>canonical"]:::canonical
  c2["-12b53192<br/>superseded_by c1"]:::superseded
  c3["-7708b37f<br/>superseded_by c1<br/>(17127 bytes — divergent draft)"]:::superseded

  r3["<b>Alloomi 项目概览设计方案</b><br/>canonical"]:::canonical
  r4["-9eacf632<br/>superseded_by r3"]:::superseded

  c1 -->|superseded_by| c2
  c1 -->|superseded_by| c3
  r3 -->|superseded_by| r4

  c4["16 【PRD】Alloomi 知识库"]
  r1["Alloomi 项目设计方案"]
  r2["Alloomi 项目详情页设计方案"]
  c4 -.independent.-> c1
  r1 -.sibling.-> r3
  r2 -.sibling.-> r3
```

The 8 unique documents collapse to **5 canonical concepts** once the
3 hash-suffixed duplicates are folded in. (`-7708b37f` is 17127 bytes
versus 6229 for the canonical — the re-upload has materially different
content, so it's a divergence, not a duplicate; worth surfacing as a
separate node in any future supersedes-aware graph.)

## Verifier commands

Reproduced with these one-liners:

```bash
# 1. Boot serve against the injected bundle, dump graph.json
PORT=$((30000 + RANDOM % 10000))
node -e '
  import("/Users/timi/codes/opencontext/packages/okf/dist/serve.js").then(async (m) => {
    const server = await m.startOkfServe({ from: "/tmp/okf-injected-<ts>", port: '"$PORT"' });
    const g = await (await fetch(server.url + "/api/graph")).json();
    console.log(JSON.stringify(g));
    await server.stop();
  });
'

# 2. Same against the raw dingtalk bundle (no injection) — all nodes
#    fall back to type=Reference and tags=[]
node -e '
  import("/Users/timi/codes/opencontext/packages/okf/dist/serve.js").then(async (m) => {
    const server = await m.startOkfServe({ from: "/Users/timi/Downloads/Alloomi数字员工引导流程", port: '"$PORT"' });
    const g = await (await fetch(server.url + "/api/graph")).json();
    console.log("nodes=" + g.nodes.length + " edges=" + g.edges.length + " types=" + JSON.stringify(g.types));
    await server.stop();
  });
'
```
