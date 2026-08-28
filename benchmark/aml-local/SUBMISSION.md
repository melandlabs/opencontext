# AML Submission — OpenContext

Materials for the [Agent Memory Leaderboard](https://agentmemoryleaderboard.ai)
application. Fill in the `<placeholders>` before submitting; everything else
is ready to paste.

## Common materials

| Field | Value |
|---|---|
| **System name** | OpenContext |
| **Version** | `@melandlabs/opencontext@0.8.0` (see [packages/opencontext/package.json](../../packages/opencontext/package.json)) |
| **Organization** | Meland Labs |
| **Contact** | `<name>` — `<email>` |
| **Division** | `<Academic \| Commercial>` |
| **Base URL** | `https://<your-public-host>` (see [DEPLOY.md](./DEPLOY.md)) |
| **Endpoints** | `<base>/add`, `<base>/search`, `<base>/health` |
| **Memory System Key** | `<the AML_SYSTEM_KEY you generated>` (sent as `Authorization: Bearer <key>` or `X-Api-Key: <key>`) |
| **Docker** | `docker build -t opencontext-aml . && docker run -p 7422:7422 -v opencontext-data:/data -e AML_SYSTEM_KEY=... opencontext-aml` (root [Dockerfile](../../Dockerfile)) |
| **Repository** | https://github.com/melandlabs/opencontext |

## Method description

OpenContext is an open-source memory substrate built around a **temporal
context graph**: every fact carries `valid_from` / `valid_until`, and
supersession, contradiction and merge are first-class, append-only edges
(see [docs/architecture.md](../../docs/architecture.md)). For the AML
hosted evaluation the system is wired as:

- **Write path** — each platform `Add` is stored as raw messages in the
  daemon (`POST /v1/raw-messages`) with synchronous embedding
  (`embedOnInsert`), so a 200 response means the memories are already
  searchable. Message ids are derived from the platform `request_id`,
  making retries idempotent. `user_id` is passed through verbatim as the
  isolation scope.
- **Read path** — each `Search` runs hybrid retrieval (BM25 + vector with
  reciprocal-rank fusion) over sqlite-vec, returning the top-k memories
  relevance-ordered. An optional LLM reasoning layer (query rewrite /
  iterative multi-step retrieval) exists but is **off** in the submission
  image.
- **Models** — local ONNX embeddings only; the Add/Search chain calls no
  external LLM, so it satisfies the platform's model constraints by
  construction.

## Attribution / prior work

The evaluation datasets and scoring pipelines are the work of the AML
authors and the original benchmark authors; this repository vendors the
official AML pipelines unmodified under
[`benchmark/AML-agent-memory-leaderboard/`](../AML-agent-memory-leaderboard/)
(local execution shim only, see [README](./README.md)). The six textual
benchmarks:

| Benchmark | Source | License / note |
|---|---|---|
| LongMemEval-S | LongMemEval (Wu et al.) | see upstream repo |
| LoCoMo (refined) | LoCoMo (Snapdragon/MemoryBench authors); local runs use the community LoCoMo-V2 cleanup | see upstream repos |
| BEAM | BEAM authors | local runs use the public sample; platform holds the full set |
| CL-bench | CL-bench authors | — |
| PersonaMem | PersonaMem-v2 authors | public CSV + 32k histories locally |
| ScriptMem | ScriptMem authors | **CC BY-NC 4.0**; original script text is not published — local runs validate the chain only |

## Dependency disclosure (participant side)

- Runtime: Node.js ≥ 22, pnpm 10, Python 3 (adapter only, stdlib-only)
- Packages: `@melandlabs/opencontext@0.8.0` (+ workspace packages), built
  from this repo by the root Dockerfile
- Storage: SQLite + sqlite-vec (embedded, no external services)
- Embeddings: local ONNX model (downloaded on first use; no API key)
- Optional (not used by the submission image): OpenAI-compatible LLM for
  the reasoning retrieval layer

## Run Label

Issue one with [`run_label.py`](./run_label.py) — it embeds the package
version and UTC date, dedupes via `outputs/run_labels.log`, and records the
label ↔ git commit ↔ image digest mapping:

```powershell
python run_label.py official --image sha256:<digest>
# -> opencontext-0.8.0-20260828-official-1
```

## Contract cross-reference (platform guide → this repo)

| AML API-guide clause | Implementation |
|---|---|
| `POST /add` request shape | [contract/add.schema.json](./contract/add.schema.json); handler `handle_add` in [serve.py](./serve.py) |
| Add returns 200 only when searchable | `embedOnInsert: True` in `handle_add` (synchronous embedding before response) |
| Add idempotency on platform retries | messageId derived as `aml:<request_id>:<i>` in `handle_add` |
| `POST /search` response `data[]`, top_k honored | `handle_search` maps daemon hits to `{id, content, score, created_at}`, `limit=top_k` |
| Per-sample isolation | `user_id` passed through verbatim as the OpenContext `userId` (both handlers) |
| `GET /health` 200 | `Handler.do_GET` |
| Auth: Memory System Key / Eval Key | `_authorized` + `EVAL_KEY_HEADERS` (top of serve.py) |
| Retry contract (Add: 408/409/425/429/5xx; Search: same minus 409) | 4xx marked `retriable: false`; 5xx via `_send_retriable` with `Retry-After` |
| Schema-validate examples | `fixtures/*.example.json` + `python test_contract.py [--live]` |
| Containerized startup | root [Dockerfile](../../Dockerfile) + [docker-entrypoint.sh](./docker-entrypoint.sh) |
| Public reachability + 30-day stability | [DEPLOY.md](./DEPLOY.md) |
| Prebuilt image | GHCR via [aml-image.yml](../../.github/workflows/aml-image.yml) |

## Before-you-submit checklist

- [ ] Docker image builds and `/health` is 200 (see [DEPLOY.md](./DEPLOY.md))
- [ ] `python test_contract.py --live <base-url> --api-key $AML_SYSTEM_KEY` passes
- [ ] `AML_SYSTEM_KEY` set; auth verified on (401 without the key)
- [ ] Eval Key wired into `AML_EVAL_KEY` once issued; header names in
      `EVAL_KEY_HEADERS` confirmed against the platform's real requests
- [ ] Public URL committed for ≥ 30 days; restart policy + uptime probe live
- [ ] Contact / division / placeholders above filled in
- [ ] Run Label issued for the official run
