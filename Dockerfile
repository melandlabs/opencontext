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

# Memory data + local embedding model cache. Persist this volume for the
# duration of the evaluation (30-day stability window).
VOLUME /data
ENV OPENCONTEXT_DATA_DIR=/data \
    AML_ADAPTER_PORT=7422 \
    EMBEDDING_PROVIDER=local \
    MEMORY_BACKEND=sqlite-vec
    # AML_SYSTEM_KEY  — Memory System Key (you generate, share with platform); REQUIRED in production
    # AML_EVAL_KEY    — Eval Key (platform issues to you after approval)
    # LOCAL_EMBEDDING_REMOTE_HOST — optional mirror for the local ONNX model download

EXPOSE 7422
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:7422/health', timeout=4).status == 200 else 1)"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
