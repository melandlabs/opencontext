"""Run an AML pipeline without modifying the vendored AML repo.

The published AML pipelines (data/<bench>/pipeline*.py) pass plain `open()`
file handles into `async with`, which CPython does not support. Instead of
patching the vendored files, this shim patches `pathlib.Path.open` at runtime
so write/append handles gain the async context-manager protocol, then executes
the target pipeline with the remaining CLI arguments. Answering and scoring
logic is untouched.

Usage:
  python run_pipeline.py <path-to-pipeline.py> [pipeline args...]

Example:
  python run_pipeline.py ../AML-agent-memory-leaderboard/data/personamem/pipeline_v2.py answer --input in.jsonl --output out.jsonl --mode mcq
"""
from __future__ import annotations

import runpy
import sys
from pathlib import Path


class _AsyncFileWrapper:
    """Adds the async context-manager protocol to a plain file object
    (sync `with` keeps working, e.g. Path.write_text)."""

    def __init__(self, fileobj):
        self._file = fileobj

    def __enter__(self):
        return self._file.__enter__()

    def __exit__(self, *exc):
        return self._file.__exit__(*exc)

    async def __aenter__(self):
        return self._file

    async def __aexit__(self, *exc):
        self._file.close()
        return False

    def __getattr__(self, name):
        return getattr(self._file, name)


_original_open = Path.open


def _patched_open(self, mode="r", *args, **kwargs):
    fileobj = _original_open(self, mode, *args, **kwargs)
    if any(flag in mode for flag in "wax+"):
        return _AsyncFileWrapper(fileobj)
    return fileobj


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    pipeline = sys.argv[1]
    Path.open = _patched_open
    sys.argv = [pipeline] + sys.argv[2:]
    runpy.run_path(pipeline, run_name="__main__")


if __name__ == "__main__":
    main()
