# DEPLOY — exposing the AML adapter publicly

The AML evaluation is **hosted**: the platform calls your `POST /add`,
`POST /search` and `GET /health` over the public internet, and the service
must stay reachable for the full evaluation window (~30 days). This file
covers the deployment contract, three exposure options, and the minimum
operations needed to hold the SLA.

## 1. What must be true before you apply

- [ ] `docker build -t opencontext-aml .` succeeds from the repo root
- [ ] Container starts and `GET /health` returns 200 (`{"ok": true}`)
- [ ] `python benchmark/aml-local/test_contract.py --live https://<your-base-url> --api-key $AML_SYSTEM_KEY` passes end-to-end
- [ ] `AML_SYSTEM_KEY` (Memory System Key) is set — auth is **on**, not off
- [ ] The base URL is stable for ≥ 30 days (no ephemeral tunnel URLs)
- [ ] Data volume (`/data`) is persistent — deleting it mid-eval deletes the memories the platform already Added

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

## 6. If the contract differs once the Eval Key arrives

The adapter was written against the public API guide. If the issued
credentials or paths differ, the adjustment points are all at the top of
[`serve.py`](./serve.py): `EVAL_KEY_HEADERS` (Eval Key header names),
`AML_SYSTEM_KEY` header handling in `_authorized`, and the path mapping in
`do_GET`/`do_POST`. Re-run `test_contract.py --live` after any change.
