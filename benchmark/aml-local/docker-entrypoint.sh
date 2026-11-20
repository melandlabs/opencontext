#!/bin/sh
# Container entrypoint for the AML submission image.
# Starts the OpenContext daemon (internal, :7421), waits for health, then
# exec's the AML Add/Search adapter (public, :7422).
set -e

DATA_DIR="${OPENCONTEXT_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
cd "$DATA_DIR"

# The daemon resolves its SQLite store from MEMORY_STORE_DB_PATH and falls
# back to $OPENCONTEXT_HOME/memory/store.db. Without these exports the store
# lands in /root/.opencontext — inside the container's writable layer — so
# every ingested memory disappears on the next restart and the 30-day
# stability window is broken.
export OPENCONTEXT_HOME="$DATA_DIR"
export MEMORY_STORE_DB_PATH="${MEMORY_STORE_DB_PATH:-$DATA_DIR/memory/store.db}"
mkdir -p "$(dirname "$MEMORY_STORE_DB_PATH")"

# Keep the ONNX models on the same volume. A cold cache re-downloads them on
# every start, and the download is the slowest part of a cold first Add.
export LOCAL_EMBEDDING_CACHE_DIR="${LOCAL_EMBEDDING_CACHE_DIR:-$DATA_DIR/models/embeddings}"
export LOCAL_RERANKER_CACHE_DIR="${LOCAL_RERANKER_CACHE_DIR:-$DATA_DIR/models/reranker}"
mkdir -p "$LOCAL_EMBEDDING_CACHE_DIR" "$LOCAL_RERANKER_CACHE_DIR"

EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-local}"
RERANKER_PROVIDER="${RERANKER_PROVIDER:-local}"

# The local embedder truncates at 512 model tokens. The default child size
# (400 *estimated* tokens ≈ 2 000 characters) is bigger than that for
# English text, so the tail of a child was silently dropped before it was
# ever indexed. Tokenizer-aware chunking keeps every child inside the
# model's input window.
CHUNK_ARGS=""
if [ "$EMBEDDING_PROVIDER" = "local" ]; then
  CHUNK_ARGS="--chunk-max-tokens ${CHUNK_MAX_TOKENS:-384} --chunk-overlap-tokens ${CHUNK_OVERLAP_TOKENS:-64}"
fi

echo "[entrypoint] starting opencontext daemon on 127.0.0.1:7421 (backend=${MEMORY_BACKEND:-sqlite-vec}, embeddings=${EMBEDDING_PROVIDER}, reranker=${RERANKER_PROVIDER})"
# shellcheck disable=SC2086 # CHUNK_ARGS is a deliberate word-split list
node /opt/opencontext/dist/cli/opencontext.js http \
  --host 127.0.0.1 \
  --port 7421 \
  --embedding-provider "$EMBEDDING_PROVIDER" \
  --reranker-provider "$RERANKER_PROVIDER" \
  --memory-backend "${MEMORY_BACKEND:-sqlite-vec}" \
  $CHUNK_ARGS &
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
