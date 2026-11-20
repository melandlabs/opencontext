"""Regression tests for the AML container entrypoint.

The daemon resolves its SQLite store from ``MEMORY_STORE_DB_PATH`` and falls
back to ``$OPENCONTEXT_HOME/memory/store.db``. If the entrypoint does not
export either one, the store is written to the container's writable layer
(``/root/.opencontext``) instead of the ``/data`` volume: every ingested
memory is lost on the next restart, and the 30-day stability window the AML
platform asks for is silently broken.

These tests read the shell script as text -- they do not need Docker.
"""

from __future__ import annotations

import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENTRYPOINT = HERE / "docker-entrypoint.sh"
DOCKERFILE = HERE.parent.parent / "Dockerfile"


def _script() -> str:
    return ENTRYPOINT.read_text(encoding="utf-8")


def test_the_entrypoint_points_the_store_at_the_data_volume() -> None:
    script = _script()
    assert 'export OPENCONTEXT_HOME="$DATA_DIR"' in script
    assert 'export MEMORY_STORE_DB_PATH="${MEMORY_STORE_DB_PATH:-$DATA_DIR/memory/store.db}"' in script


def test_the_entrypoint_keeps_the_model_cache_on_the_same_volume() -> None:
    script = _script()
    assert 'export LOCAL_EMBEDDING_CACHE_DIR="${LOCAL_EMBEDDING_CACHE_DIR:-$DATA_DIR/models/embeddings}"' in script
    assert 'export LOCAL_RERANKER_CACHE_DIR="${LOCAL_RERANKER_CACHE_DIR:-$DATA_DIR/models/reranker}"' in script


def test_the_entrypoint_exports_the_store_before_the_daemon_starts() -> None:
    script = _script()
    export_at = script.index('export MEMORY_STORE_DB_PATH=')
    daemon_at = script.index("node /opt/opencontext/dist/cli/opencontext.js http")
    assert export_at < daemon_at


def test_the_entrypoint_still_starts_the_daemon_and_the_adapter() -> None:
    script = _script()
    assert "node /opt/opencontext/dist/cli/opencontext.js http" in script
    assert "exec python3 /app/serve.py" in script


def test_the_dockerfile_publishes_the_data_volume() -> None:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    assert re.search(r"^VOLUME /data\s*$", dockerfile, re.MULTILINE)
    assert "OPENCONTEXT_DATA_DIR=/data" in dockerfile


def test_the_dockerfile_keeps_the_reranker_on_by_default() -> None:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    assert "RERANKER_PROVIDER=local" in dockerfile
    assert "EMBEDDING_PROVIDER=local" in dockerfile
    assert "MEMORY_BACKEND=sqlite-vec" in dockerfile
