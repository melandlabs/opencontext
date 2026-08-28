#!/bin/sh
# Container entrypoint for the AML submission image.
# Starts the OpenContext daemon (internal, :7421), waits for health, then
# exec's the AML Add/Search adapter (public, :7422).
set -e

DATA_DIR="${OPENCONTEXT_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
cd "$DATA_DIR"

echo "[entrypoint] starting opencontext daemon on 127.0.0.1:7421 (backend=${MEMORY_BACKEND:-sqlite-vec}, embeddings=${EMBEDDING_PROVIDER:-local})"
node /opt/opencontext/dist/cli/opencontext.js http \
  --host 127.0.0.1 \
  --port 7421 \
  --embedding-provider "${EMBEDDING_PROVIDER:-local}" \
  --memory-backend "${MEMORY_BACKEND:-sqlite-vec}" &
DAEMON_PID=$!

# Note: the first request with --embedding-provider local downloads the ONNX
# model (LOCAL_EMBEDDING_REMOTE_HOST overrides the mirror). The health wait
# below covers daemon startup; the first Add may still take a while on a
# cold cache — persist $DATA_DIR and the model cache in a volume.
i=0
until python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:7421/health', timeout=2).status == 200 else 1)" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 150 ]; then
    echo "[entrypoint] daemon failed to become healthy after ~5min" >&2
    exit 1
  fi
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "[entrypoint] daemon process exited during startup" >&2
    exit 1
  fi
  sleep 2
done
echo "[entrypoint] daemon healthy"

export OPENCONTEXT_URL="${OPENCONTEXT_URL:-http://127.0.0.1:7421}"
echo "[entrypoint] starting AML adapter on 0.0.0.0:${AML_ADAPTER_PORT:-7422}"
exec python3 /app/serve.py
