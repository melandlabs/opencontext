# DEPLOY — exposing the AML adapter publicly

The AML evaluation is **hosted**: the platform calls your `POST /add`,
`POST /search` and `GET /health` over the public internet, and the service
must stay reachable for the full evaluation window (~30 days). This file
covers the deployment contract, three exposure options, and the minimum
operations needed to hold the SLA.

## 1. What must be true before you apply

- [ ] `docker build -t opencontext-aml .` succeeds from the repo root
- [ ] Container starts and `GET /health` returns 200 (`{"ok": true}`)
- [ ] `python benchmark/aml-local/gate_check.py --adapter-url http://127.0.0.1:7422 --daemon-url http://127.0.0.1:7421` passes every gate
- [ ] `python benchmark/aml-local/test_contract.py --live https://<your-base-url> --api-key $AML_SYSTEM_KEY` passes end-to-end
- [ ] `AML_SYSTEM_KEY` (Memory System Key) is set — auth is **on**, not off
- [ ] The base URL is stable for ≥ 30 days (no ephemeral tunnel URLs)
- [ ] Data volume (`/data`) is persistent — deleting it mid-eval deletes the memories the platform already Added
- [ ] The volume holds both the store and the model cache (`/data/memory/store.db`, `/data/models/…`) — the entrypoint points the daemon at them, so a restart keeps the memories
- [ ] The volume was created **after** the current embedding model / chunk rules were chosen — an index is not migrated when either changes (see §7)

## 2. Run the container

Build locally, or pull the prebuilt image from GHCR (published by the
[`aml-image`](../../.github/workflows/aml-image.yml) workflow on `aml-v*` tags
or manual dispatch):

```bash
# option 1: pull the prebuilt image
docker pull ghcr.io/melandlabs/opencontext-aml:latest
docker tag ghcr.io/melandlabs/opencontext-aml:latest opencontext-aml

# option 2: build from source
docker build -t opencontext-aml .
```

Then:

```bash
docker run -d --name opencontext-aml \
  --restart unless-stopped \
  -p 7422:7422 \
  -v opencontext-data:/data \
  -e AML_SYSTEM_KEY='<a-strong-random-key-you-generate>' \
  -e AML_EVAL_KEY='<issued-by-platform-after-approval>' \
  opencontext-aml
```

Notes:

- Only port **7422** (the adapter) is exposed. The daemon binds
  `127.0.0.1:7421` inside the container and is not reachable from outside.
- `--restart unless-stopped` (or your orchestrator's equivalent) is the
  first line of the 30-day SLA — the container must come back after host
  reboots and crashes.
- The first Add with `EMBEDDING_PROVIDER=local` downloads the ONNX
  embedding model. Warm it once (`test_contract.py --live`) before handing
  the URL to the platform, and keep `/data` on a persistent volume so the
  model cache and sqlite-vec store survive restarts. Set
  `LOCAL_EMBEDDING_REMOTE_HOST` if the default model host is unreachable
  from your region.
- What the volume holds, and why it has to:

  | Path | Contents |
  | --- | --- |
  | `/data/memory/store.db` | the ingested messages and their vectors |
  | `/data/models/embeddings` | the ONNX embedding model (embedder) |
  | `/data/models/reranker` | the ONNX cross-encoder (reranker) |

  The entrypoint exports `OPENCONTEXT_HOME`, `MEMORY_STORE_DB_PATH`,
  `LOCAL_EMBEDDING_CACHE_DIR` and `LOCAL_RERANKER_CACHE_DIR` so the daemon
  uses exactly these paths. Without them the daemon would fall back to
  `/root/.opencontext` — the container's writable layer — and every ingested
  memory would be lost on the next restart.
- The reranker is **on by default** (`RERANKER_PROVIDER=local`). It is
  worth roughly +15 points of source recall over the RRF order alone; a
  deployment without it is a different system than the one the numbers in
  `benchmark/beam/docs` describe.
- The local embedder truncates at 512 model tokens, so the container chunks
  with a tokenizer-aware budget (`CHUNK_MAX_TOKENS=384`,
  `CHUNK_OVERLAP_TOKENS=64`). The default child size is larger than the
  model window, which would silently drop the tail of a long message.
- A stronger embedding endpoint is a drop-in replacement, not a rewrite:

  ```bash
  docker run -d --name opencontext-aml \
    -p 7422:7422 -v opencontext-data:/data \
    -e AML_SYSTEM_KEY='<key>' \
    -e EMBEDDING_PROVIDER=openai-compatible \
    -e EMBEDDING_BASE_URL='https://dashscope-intl.aliyuncs.com/compatible-mode/v1' \
    -e EMBEDDING_API_KEY='<key>' \
    -e EMBEDDING_MODEL='text-embedding-v4' \
    -e EMBEDDING_DIMENSIONS=1024 \
    opencontext-aml
  ```

  Use a **fresh volume** for a different embedding model — see §7.

## 3. Exposure options (pick one)

### Option A — Cloudflare Tunnel (recommended for long windows)

Stable public hostname on your own subdomain; free; survives restarts.

```bash
# one-time: cloudflared tunnel login && cloudflared tunnel create aml
# config.yml:  tunnel: <id> / credentials-file / ingress:
#   - hostname: aml.yourdomain.com
#     service: http://localhost:7422
#   - service: http_status:404
cloudflared tunnel run aml   # or: install as a system service
```

Base URL for the application: `https://aml.yourdomain.com`.

### Option B — fly.io (managed container host)

```bash
fly launch --no-deploy          # generates fly.toml; set internal_port = 7422
fly volumes create opencontext_data --size 10   # persistent /data
fly secrets set AML_SYSTEM_KEY=... 
fly deploy
```

Mount the volume at `/data` in `fly.toml` and set
`[http_service] auto_stop_machines = false` so the machine never sleeps.

### Option C — VPS + Caddy/nginx (full control)

Any small VM (≥ 2 GB RAM) with Docker. Run the container as above, then
terminate TLS with Caddy:

```
aml.yourdomain.com {
    reverse_proxy 127.0.0.1:7422
}
```

### (dev only) ngrok

`ngrok http 7422` is fine for the Eval-Key smoke test, but the free tier
rotates hostnames — do **not** submit an ngrok URL for the official run.

## 4. 30-day SLA — minimum operations

1. **Restart policy**: `--restart unless-stopped` / fly auto-start / a
   systemd unit. Non-negotiable.
2. **Health monitoring**: point any external uptime probe (UptimeRobot,
   Better Stack, Grafana Cloud free tier) at `GET /health`, alert on
   2+ consecutive failures.
3. **Logs**: `docker logs --since 24h opencontext-aml` (or ship with
   `docker run --log-driver`). The adapter is quiet by design; the daemon
   logs retrieval/embedding errors to stdout.
4. **Disk**: watch the volume — sqlite grows with every Add. 10 GB is
   comfortable for the full evaluation.
5. **No deploys mid-eval**: only redeploy on critical failure; the
   platform's Adds are cumulative and keyed to your stored state.

## 5. Capacity note (measured)

Probe against the submission image (WSL2, 6 GB RAM, sqlite-vec + local ONNX,
2026-08-28): Search ≈ 79 req/s @ conc 16 and ≈ 106 req/s @ conc 64; Add
(idempotent upsert of a 2-message session) ≈ 82 req/s @ conc 16; single Search
latency ~9 ms. This comfortably covers the AML concurrency envelope (Search
16–256, Add 16–64, top_k up to 100). Re-probe on the real host before the
official run; watch memory during long Adds, since embedding is CPU-bound.

## 6. Readiness gates (run them before you hand over the URL)

`GET /health` is liveness: it answers as long as the process is up. The
gates are readiness: they assert that the retrieval pipeline is actually
wired, and they exit non-zero when it is not.

```bash
# inside the container, or against a running deployment
python benchmark/aml-local/gate_check.py \
  --adapter-url http://127.0.0.1:7422 \
  --daemon-url http://127.0.0.1:7421
```

| Gate | Fails when |
| --- | --- |
| `embedding_wired` | no embedding provider/model is configured |
| `embedding_model_matches_index` | the index was written by a different embedding model — or by two models at once — so the vectors are not comparable and the semantic channel has to be re-indexed |
| `embedding_dimensions_match_index` | the daemon produces a different vector width than the index holds |
| `semantic_ready` / `lexical_ready` | the dense or the FTS5 channel is not usable |
| `reranker_ready` | the reranker is off (waive with `--allow-no-reranker` for an explicit ablation only) |
| `round_trip_add_search` | an added memory cannot be found again |
| `evidence_is_dated_and_attributed` | the rendered evidence lost its `[YYYY-MM-DD HH:MM] speaker:` prefix — the answer model can no longer resolve "when" and "who" |
| `user_isolation` | one user's memory is visible to another user |
| `top_k_100` / `top_k_respected` | the platform's Top-K contract is not honoured |
| `no_5xx_under_concurrency` | a concurrent burst produces a retriable error |

The order matters: the round trip adds a message first, because the
embedding of a new chunk lands asynchronously. The semantic gates then poll
the daemon for up to `--semantic-timeout` seconds (60 by default) instead of
failing a healthy cold deployment.

The daemon reports the same facts on its own `/health` under `retrieval`
(`semanticReady`, `lexicalReady`, `rerankerReady`, `indexedDimensions`,
`indexedEmbeddingModels`, `semanticDegradedReason`).

The round-trip gate Adds one canary message and Searches for it again, so
it leaves a single row in whatever store the daemon uses. Against a
deployment that is harmless (the row is invisible to the platform, which
scopes every query to its own `user_id`). Against a **local** store that
holds real data, run the gate check against a scratch instance —
`MEMORY_STORE_DB_PATH=/tmp/gate/store.db` — or delete the row afterwards
(`select id from raw_messages where user_id like 'gate-check-%'`).

## 7. Changing the model, the provider or the chunk rules

`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` and the
chunk rules decide how a message is cut and what a vector means. They are
baked into the index:

- the vectors of one model cannot be compared with the vectors of another,
  so a mixed volume answers with quietly wrong neighbours;
- the chunk rules decide which text a vector stands for, so a re-chunked
  volume mixes incomparable fragments.

Start such a run with a **fresh volume** (`docker volume rm opencontext-data`
or a new volume name). The daemon detects the mismatch and reports
`semanticDegradedReason: "semantic_model_mismatch"` instead of pretending
to be healthy.

## 8. If the contract differs once the Eval Key arrives

The adapter was written against the public API guide. If the issued
credentials or paths differ, the adjustment points are all at the top of
[`serve.py`](./serve.py): `EVAL_KEY_HEADERS` (Eval Key header names),
`AML_SYSTEM_KEY` header handling in `_authorized`, and the path mapping in
`do_GET`/`do_POST`. Re-run `test_contract.py --live` after any change.

## 9. Experiments (the submitted run stays locked)

The submitted configuration is the measured one: reranker on, Top-K 100, one
memory per turn, evidence rendered as `[YYYY-MM-DD HH:MM] speaker: text`.
Anything else is an experiment and has to be measured before it is adopted —
a knob that is not in the run report is a knob nobody can reproduce.

One knob is available for a deliberate A/B:

| Variable | Default | Effect |
| --- | --- | --- |
| `AML_SESSION_NEIGHBOR_EXPANSION` | off | `protected` keeps the direct hits in front and fills the remaining slots with the neighbouring turns of each top hit; `union` hands every candidate to the reranker |
| `AML_SESSION_NEIGHBOR_WINDOW` | 1 | how many messages on each side of a hit count as neighbours |
| `AML_SESSION_NEIGHBOR_SLOTS` | 4 | how many neighbours may enter the result in `protected` mode |

The neighbouring turns matter because a memory is a *turn*: "the trip was
wonderful" carries no subject, and the subject usually sits in the previous
turn. The risk is the opposite one — the AML judge counts an extra item in a
list answer as WRONG, so more context can also mean more wrong answers. That
is exactly why it is off by default.

To compare two arms, keep the volume, the model and the chunk rules fixed and
change only the knob; run the local harness twice with the same dataset slice
and record both run manifests (see [README](./README.md) for the comparability
rules: Top-K 100, one memory per turn, no invented dates).

