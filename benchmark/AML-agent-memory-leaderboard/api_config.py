"""Credential-free configuration adapter for the public evaluation pipelines."""
from __future__ import annotations

import os


ANSWER_API_BASE = os.environ.get("ANSWER_API_BASE", "").rstrip("/")
ANSWER_API_KEY = os.environ.get("ANSWER_API_KEY", "")
ANSWER_MODEL = os.environ.get("ANSWER_MODEL", "")

JUDGE_API_BASE = os.environ.get("JUDGE_API_BASE", "").rstrip("/")
JUDGE_API_KEY = os.environ.get("JUDGE_API_KEY", "")
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "")
JUDGE_VERSION = os.environ.get("JUDGE_VERSION", "")


class _AsyncFileWrapper:
    """Local workaround: the published pipelines pass plain `open()` handles into
    `async with`, which CPython does not support. This wrapper adds the async
    context-manager protocol without changing any scoring/answering behaviour."""

    def __init__(self, path, mode):
        self._file = open(path, mode, encoding="utf-8")

    async def __aenter__(self):
        return self._file

    async def __aexit__(self, *exc):
        self._file.close()
        return False


def _afile(path, mode):
    return _AsyncFileWrapper(path, mode)
