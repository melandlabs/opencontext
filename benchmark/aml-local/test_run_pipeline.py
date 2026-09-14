"""Unit tests for the non-vendored AML pipeline compatibility shim."""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import unittest
from pathlib import Path

import httpx


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("aml_local_run_pipeline", HERE / "run_pipeline.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load run_pipeline.py")
run_pipeline = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = run_pipeline
SPEC.loader.exec_module(run_pipeline)


class TransportRetryTests(unittest.TestCase):
    def test_retries_transient_transport_error_and_returns_response(self) -> None:
        original_post = run_pipeline._original_post
        calls = 0

        async def fake_post(_client, _url, *_args, **_kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise httpx.RemoteProtocolError("incomplete chunked read")
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        async def no_sleep(_delay: float) -> None:
            return None

        try:
            run_pipeline._original_post = fake_post
            old_sleep = run_pipeline.asyncio.sleep
            run_pipeline.asyncio.sleep = no_sleep
            response = asyncio.run(run_pipeline._post_with_transport_retries(object(), "https://example.test/chat/completions"))
        finally:
            run_pipeline._original_post = original_post
            run_pipeline.asyncio.sleep = old_sleep

        self.assertEqual(calls, 2)
        self.assertEqual(response.status_code, 200)


if __name__ == "__main__":
    unittest.main()
