"""Tests for transport compatibility used by non-BEAM pipelines."""
import asyncio
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

SPEC = importlib.util.spec_from_file_location("aml_local_run_pipeline", Path(__file__).with_name("run_pipeline.py"))
run_pipeline = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = run_pipeline
SPEC.loader.exec_module(run_pipeline)


class TransportRetryTests(unittest.TestCase):
    def test_transport_recovery_remains_available(self):
        calls = []
        async def post(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                raise httpx.RemoteProtocolError("incomplete response")
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})
        async def no_sleep(_delay):
            pass
        with patch.object(run_pipeline, "_original_post", post), patch.object(run_pipeline.asyncio, "sleep", no_sleep):
            response = asyncio.run(run_pipeline._post_with_transport_retries(object(), "https://example.test"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(calls), 2)

    def test_beam_dispatch_cannot_be_disabled_by_legacy_flag(self):
        with patch.dict("os.environ", {"AML_PUBLIC_BEAM_FLOW": "0"}), patch.object(sys, "argv", [
            "run_pipeline.py", "../AML-agent-memory-leaderboard/data/beam/pipeline.py", "answer"
        ]), patch("beam_runtime.main", return_value=2) as execute:
            with self.assertRaises(SystemExit) as result:
                run_pipeline.main()
        self.assertEqual(result.exception.code, 2)
        execute.assert_called_once()


if __name__ == "__main__":
    unittest.main()
