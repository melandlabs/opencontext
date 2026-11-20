# AML (Agent Memory Leaderboard) submission image for OpenContext.
#
# One container = the full memory system the AML platform evaluates:
#   * OpenContext daemon (internal, 127.0.0.1:7421) — ingestion + hybrid retrieval
#   * AML Add/Search adapter (public, 0.0.0.0:7422) — benchmark/aml-local/serve.py
#
# Build:  docker build -t opencontext-aml .
# Run:    docker run -p 7422:7422 -v opencontext-data:/data \
#           -e AML_SYSTEM_KEY=<you-generate-this> opencontext-aml
# See benchmark/aml-local/DEPLOY.md for public exposure and the 30-day SLA.

# ---------- build stage ----------
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /repo
COPY . .
ENV NODE_OPTIONS=--max-old-space-size=8192
RUN pnpm install --frozen-lockfile
# Build @melandlabs/opencontext and every workspace package it depends on.
RUN pnpm --filter "@melandlabs/opencontext..." build
# Produce a lean, production-only install of the CLI package. --legacy:
# the workspace does not set inject-workspace-packages; all workspace deps of
# @melandlabs/opencontext are devDependencies already bundled by tsup.
RUN pnpm --filter @melandlabs/opencontext deploy --legacy --prod /opt/opencontext

# ---------- runtime stage ----------
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/opencontext /opt/opencontext
COPY benchmark/aml-local/serve.py /app/serve.py
COPY benchmark/aml-local/docker-entrypoint.sh /app/docker-entrypoint.sh
# Normalize line endings (repo may be checked out with CRLF on Windows).
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh

# The volume holds everything the evaluation needs to survive a restart:
#   /data/memory/store.db   the SQLite store (the ingested messages)
#   /data/models/…          the ONNX embedding + reranker model cache
# The entrypoint points MEMORY_STORE_DB_PATH / OPENCONTEXT_HOME /
# LOCAL_*_CACHE_DIR at those paths, so persisting this volume is what keeps
# the 30-day stability window. Persist it for the whole evaluation.
#
# The reranker is ON by default: the local cross-encoder is worth roughly
# +15 points of source recall over the RRF order alone (see the benchmark
# reports under benchmark/beam/docs). Its model is downloaded on first use,
# like the embedding model.
#
# Switching EMBEDDING_PROVIDER, EMBEDDING_MODEL or the chunk rules changes
# the index layout — existing indexes are not migrated. Start such a run
# with a fresh volume.
VOLUME /data
ENV OPENCONTEXT_DATA_DIR=/data \
    AML_ADAPTER_PORT=7422 \
    EMBEDDING_PROVIDER=local \
    RERANKER_PROVIDER=local \
    MEMORY_BACKEND=sqlite-vec
    # AML_SYSTEM_KEY  — Memory System Key (you generate, share with platform); REQUIRED in production
    # AML_EVAL_KEY    — Eval Key (platform issues to you after approval)
    # LOCAL_EMBEDDING_REMOTE_HOST — optional mirror for the local ONNX model download
    # EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL / EMBEDDING_DIMENSIONS
    #   — switch to an OpenAI-compatible endpoint (e.g. DashScope
    #     text-embedding-v4 at 1024 dimensions) instead of the local model.

EXPOSE 7422
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:7422/health', timeout=4).status == 200 else 1)"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
