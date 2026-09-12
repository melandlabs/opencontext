# Use Case: Workspace Folder Indexing

## The Scenario

You have a folder of related Markdown / PDF / DOCX files — say, three contracts, a memo, and a few public statutes you cite — and you want to **ask natural-language questions across the whole folder**:

- "Which contracts cap liability at twelve months of fees?"
- "Pull every place in `contract-A.md` that references `law-2024.md`."
- "What does `memo.md` say about indemnification carve-outs?"

Treating the folder as a **single project space** is what `@melandlabs/workspace` is for. It indexes the folder once, deduplicates by content hash, extracts Markdown links into a `cites` graph, and gives you a hybrid (lexical + semantic + cross-file) search command you can run from the terminal.

This tutorial walks you through the CLI end-to-end. No HTTP server, no MCP client, no SDK call — just `pnpm opencontext workspace …` against a folder on disk.

## What You'll Build

A reusable `~/projects/<name>/wiki/` folder you can keep updating, plus three CLI commands you'll use day-to-day:

1. **`opencontext workspace update`** — scan + chunk + embed the folder
2. **`opencontext workspace search`** — query the indexed folder (lexical / semantic / hybrid / cross-file)
3. **`opencontext workspace list`** — see what's been indexed and its current status

## Concepts Demonstrated

- **Versioned folder indexing** — re-running `update` skips unchanged files (`sha256` dedup) and creates a new version row only when content changes.
- **Cross-file reference edges** — Markdown links like `[Limitation of Liability](./b.md)` become `cites` edges in `workspace_reference_edges`. The `cross-file` strategy walks these edges to surface related context.
- **Multi-format parsing** — `.md`, `.markdown`, `.txt` are read raw; `.pdf`, `.docx`, `.pages` go through the `packages/rag` parser layer.
- **Local-first embeddings** — `EMBEDDING_PROVIDER` defaults to `local` for the `workspace` CLI, which runs `Xenova/all-MiniLM-L6-v2` (384 dims) on-device via `@huggingface/transformers`. No API key required.

## Prerequisites

- Completed [Getting Started](../00-getting-started.md) — `pnpm` workspace already installed.
- Node.js ≥ 22 (same as the rest of OpenContext).
- ~500 MB free disk for the local embedding model weights (downloaded once to `~/.cache/opencontext/local-embeddings`).

## Quick Verification

The fastest path: copy this four-line recipe and run it. The rest of the tutorial walks through what each step does and what to look for.

```bash
# 1. Make a demo folder
mkdir -p /tmp/wf-demo/wiki
cat > /tmp/wf-demo/wiki/a.md <<'EOF'
---
title: Limitation of Liability
type: contract
created: 2026-09-11
---
The aggregate liability of either party shall not exceed the fees paid in the
twelve (12) months preceding the claim. See [Indemnification](./b.md) for carve-outs.
EOF
cat > /tmp/wf-demo/wiki/b.md <<'EOF'
---
title: Indemnification
type: contract
created: 2026-09-11
---
Neither party shall indemnify the other for indirect, consequential, or
punitive damages. References: [Limitation of Liability](./a.md).
EOF

# 2. Index the folder (local embeddings by default — no OPENROUTER_API_KEY needed)
pnpm opencontext workspace update \
  --workspace-id demo --path /tmp/wf-demo/wiki --json

# 3. Lexical search — works immediately, before embeddings finish
pnpm opencontext workspace search \
  --workspace-id demo --query "limitation" --strategy lexical

# 4. Hybrid search — once the embedding fan-out has caught up
pnpm opencontext workspace search \
  --workspace-id demo --query "indemnification" --strategy hybrid --limit 3

# 5. Cross-file — expands hits along `cites` edges from the OKF graph
pnpm opencontext workspace search \
  --workspace-id demo --query "limitation" --strategy cross-file --hops 1 --json
```

If you see `2 hit(s)` and the `cites` edges in the JSON output, you're done.

> **Note:** On macOS, the CLI may print `libc++abi: ... mutex lock failed: Invalid argument` and exit non-zero after writing the result. This is a known race between `@huggingface/transformers`' ONNX worker thread and `sqlite-vec`'s native destructor — the **output is complete and correct**, just wrap with `|| true` or `2>/dev/null` if it bothers your shell:
>
> ```bash
> pnpm opencontext workspace search ... || true
> ```

## Step-by-Step Walkthrough

### Step 1: Pick a folder

Any folder works. The indexer walks it recursively and picks a `resource_type` per file based on the extension:

| Extension | `resource_type` | Indexed? |
| --- | --- | --- |
| `.md`, `.markdown` | `note` (or whatever the OKF front-matter `type:` says) | yes — pass-through; OKF front-matter is parsed; Markdown links become `cites` edges |
| `.txt` | `note` | yes — pass-through |
| `.pdf` | `document` | yes — goes through `@melandlabs/rag` parser (text + page-level metadata) |
| `.docx` | `document` | yes — same parser pipeline |
| `.pages` | `document` | yes — same parser pipeline (macOS only) |
| `.html`, `.htm` | — | mime is recognised but the OKF walker currently skips these |
| `.xlsx`, `.numbers` | — | **not indexed** — neither the parser layer nor the OKF walker supports spreadsheets |
| `.png`, `.jpg`, … | — | **not indexed** — raster files raise an explicit "unsupported" error |

To mix formats, just drop them in the same folder. The walker picks them up in the same `update` run; the chunker and embedder don't care about the source extension once the text body is in hand:

```bash
# macOS: spin up a real .pdf and .docx alongside the markdown fixtures
echo "Public Law: cap of liability is twelve months of fees for ordinary breach." \
  > /tmp/wf-demo/wiki/law-raw.txt
textutil -convert pdf  -output /tmp/wf-demo/wiki/law.pdf  /tmp/wf-demo/wiki/law-raw.txt
textutil -convert docx -output /tmp/wf-demo/wiki/law.docx /tmp/wf-demo/wiki/law-raw.txt
rm /tmp/wf-demo/wiki/law-raw.txt
```

Markdown files get extra love: the OKF front-matter (`--- title: ... type: ... ---`) is parsed, and `[text](./other.md)` Markdown links become `cites` edges pointing from the current file to the linked file.

### Step 2: Index the folder

```bash
pnpm opencontext workspace update \
  --workspace-id demo --path /tmp/wf-demo/wiki --json
```

Output (with `--json`):

```json
{
  "ok": true,
  "exit": 0,
  "workspace_id": "demo",
  "job_id": 1,
  "status": "pending",
  "files_scanned": 2,
  "files_added": 2,
  "files_modified": 0,
  "files_unchanged": 0,
  "files_deleted": 0
}
```

What happened:

1. The folder was scanned recursively — two Markdown files.
2. Each file got a `sha256` content hash. Both files were new → `files_added: 2`.
3. Chunks were written into `workspace_chunks` synchronously (FTS5 mirror tables updated immediately via triggers).
4. An embedding **job** was created; its `enqueueEmbedding` hook fires off the local ONNX embedder (`Xenova/all-MiniLM-L6-v2`, 384 dims).
5. The CLI waits for the embedding queue to drain by default (use `--no-await-embeddings` to return immediately).
6. A vec0 child table `workspace_chunks_vec_d384` was auto-created keyed by the provider's dimension.

Re-run the same command and you'll see `files_unchanged: 2` — the `sha256` dedup means nothing gets re-chunked or re-embedded.

### Step 3: Search (lexical first)

```bash
pnpm opencontext workspace search \
  --workspace-id demo --query "limitation" --strategy lexical
```

Lexical search hits FTS5 the moment `update` returns (synchronous chunking). You don't need to wait for embeddings.

```
2 hit(s) (strategy=lexical)
  - [note] a :: --- title: Limitation of Liability type: contract created: 2026-09-11 --- # Limitation of Liability The aggregate liability of either party… (score=1.000)
  - [note] b :: …ce and wilful misconduct. References: [Limitation of Liability](./a.md).  (score=1.000)
```

Both files match because `b.md` references "Limitation of Liability" in a Markdown link — FTS5 tokenizes the link text.

### Step 4: Search (hybrid / cross-file)

Once the embedding queue has caught up:

```bash
pnpm opencontext workspace search \
  --workspace-id demo --query "limitation" --strategy cross-file --hops 1 --json
```

The `cross-file` strategy runs hybrid retrieval, then walks `cites` edges out of the top hits to expand the result set. The JSON payload shows the full hit structure:

```json
{
  "query": "limitation",
  "strategy": "cross-file",
  "total": 2,
  "hits": [
    {
      "chunk_id": "demo:3:3:chunk:0:86599afa5dfd9428",
      "resource_id": 3,
      "version_id": 3,
      "resource_type": "note",
      "resource_title": "a",
      "canonical_key": "a.md",
      "snippet": "...# Limitation of Liability\n\nThe aggregate liability of either party…",
      "matched_terms": ["limitation"],
      "score": 0.01639344262295082,
      "signals": { "lexical": 0.9999986666684445 },
      "reference_edges": [
        { "edge_type": "cites", "target_resource_id": 4 },
        { "edge_type": "cites", "target_resource_id": 3 }
      ]
    }
  ]
}
```

What to look for:

- `signals.lexical` — FTS5 BM25-derived similarity (1.0 = strong match).
- `signals.semantic` — appears once embeddings have been written.
- `reference_edges` — the `cites` graph extracted from Markdown links. Cross-file strategy uses these to expand beyond the top-N lexical hits.
- `--hops 2` walks two hops out from each seed hit (deeper expansion, more results).

### Step 5: Inspect what's indexed

```bash
pnpm opencontext workspace list --workspace-id demo --json
```

Each row includes:

- `id` — stable resource id.
- `resource_type` / `canonical_key` / `title` — from the file extension and OKF front-matter.
- `index_status` — `pending` (just indexed), `partial` (some chunks embedded), `ready` (all chunks embedded), or `failed`.
- `current_version_id` — points into `workspace_resource_versions`; new versions are created only on content change.

## Command Reference

### `opencontext workspace update`

```text
Required:
  --workspace-id <id>        Workspace identifier
  --path <folder>            Path to the OKF folder (will be scanned recursively)

Optional:
  --user <id>                User / tenant id (default: "default")
  --await-embeddings         Wait for the in-process embedding queue to drain
                             before exiting (default: on)
  --no-await-embeddings      Return as soon as synchronous indexing completes
  --drain-timeout-ms <int>   Upper bound on --await-embeddings (default 120000)
  --json                     Emit JSON envelope

Example:
  opencontext workspace update --workspace-id demo --path ./wiki
```

### `opencontext workspace search`

```text
Required:
  --workspace-id <id>        Workspace identifier
  --query <text>             Search query

Strategy:
  --strategy <name>          lexical | semantic | hybrid | cross-file
                             (default: hybrid)
  --limit <int>              Top-N hits (default: 10, max: 50)
  --threshold <float>        Semantic similarity threshold, 0..1 (default: 0.7)
  --resource-type <list>     Comma-separated filter, e.g. "note,statute"
  --hops <1|2>               Cross-file BFS depth (cross-file strategy only)

Output:
  --json                     Emit JSON envelope with full WorkspaceSearchHit[]

Example:
  opencontext workspace search --workspace-id demo --query "limitation" \
    --strategy cross-file --hops 1 --json
```

### `opencontext workspace list`

```text
Required:
  --workspace-id <id>        Workspace identifier

Filters:
  --resource-type <name>     Filter by resource type
  --index-status <status>    pending | partial | ready | failed
  --limit <int>              Max rows (default: 50)
  --offset <int>             Skip N rows (default: 0)

Output:
  --json                     Emit JSON envelope

Example:
  opencontext workspace list --workspace-id demo --index-status ready --limit 20
```

## Storage

Everything lives in the shared SQLite database at `~/.opencontext/memory/store.db` (override with `MEMORY_STORE_DB_PATH` or `--db-path`). The workspace package creates the following tables alongside the memory-store's existing schema:

- `workspace_resources` — one row per indexed file (`(workspace_id, canonical_key)` is unique).
- `workspace_resource_versions` — append-only version chain keyed by `sha256`.
- `workspace_chunks` + `workspace_chunks_fts` — text chunks with FTS5 mirror (lexical search).
- `workspace_chunks_vec_d{N}` — vec0 ANN index, dimension-suffixed so each embedder model gets its own table.
- `workspace_reference_edges` — `cites` edges extracted from Markdown links (1- and 2-hop BFS in `cross-file` strategy).
- `workspace_jobs` — indexing job log (`pending` → `ready` / `partial` / `failed`).

Inspect the tables directly:

```bash
sqlite3 ~/.opencontext/memory/store.db \
  "SELECT id, workspace_id, source_resource_id, target_resource_id, edge_type
     FROM workspace_reference_edges;"
```

## Switching Embedding Providers

`EMBEDDING_PROVIDER` controls which embedder the workspace CLI uses. The workspace CLI defaults to `local`; the wider OpenContext system still defaults to `cloud`. The provider is resolved per-process; pick whichever matches your environment:

| `EMBEDDING_PROVIDER` | Model | Dimensions | Requires |
| --- | --- | --- | --- |
| `local` *(default for `workspace`)* | `Xenova/all-MiniLM-L6-v2` | 384 | `@melandlabs/ai-rag` peer dep (already installed) |
| `cloud` | `text-embedding-3-small` via OpenRouter | 1536 | `OPENROUTER_API_KEY` |

Local is fine for most legal / contract review work where documents stay under ~512 tokens per chunk and the corpus is in English. Switch to cloud if you need multilingual coverage or longer-context embeddings:

```bash
EMBEDDING_PROVIDER=cloud pnpm opencontext workspace update --workspace-id demo --path ./wiki
```

## Known Quirks

- **macOS SIGABRT noise on exit** — `libc++abi: ... mutex lock failed: Invalid argument` after a successful run is the `@huggingface/transformers` ONNX worker racing `sqlite-vec`'s native destructor. The output above the noise is correct. Wrap with `|| true` or `2>/dev/null` in shell scripts.
- **First-run model download** — the local embedder pulls `~50 MB` of ONNX weights on first use. Subsequent runs are instant.
- **Version churn** — every `update` creates a new row in `workspace_resource_versions` if content changed. The old chunks stay queryable via their `version_id`; cleanup is deferred to a future iteration.
- **No HTTP / MCP yet** — the surface today is CLI-only. Library consumers can `import { updateWorkspaceContext, searchWorkspaceContext, listWorkspaceResources }` from `@melandlabs/workspace`.

## Next Steps

- Combine `opencontext workspace search --json` with `jq` in shell pipelines:

  ```bash
  pnpm opencontext workspace search --workspace-id demo --query "x" \
    --strategy cross-file --json 2>/dev/null \
    | jq -r '.hits[] | "\(.resource_title)\t\(.score)"'
  ```

- Mount multiple workspaces for different projects — each gets its own `(workspace_id, canonical_key)` namespace in the same SQLite file.
- Re-index when files change — `update` is idempotent on unchanged content and only re-embeds the chunks that moved.
