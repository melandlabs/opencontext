"""Offline fixture and mock HTTP tests for the AML retrieval stage."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("aml_local_retrieve", HERE / "retrieve.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load retrieve.py")
retrieve = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = retrieve
SPEC.loader.exec_module(retrieve)


class MockDaemon(ThreadingHTTPServer):
    requests: list[tuple[str, dict[str, Any]]]

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), MockHandler)
        self.requests = []


class MockHandler(BaseHTTPRequestHandler):
    server: MockDaemon

    def log_message(self, _format: str, *_args: Any) -> None:
        pass

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"ok": True})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        self.server.requests.append((self.path, payload))
        if self.path == "/v1/raw-messages":
            self.send_json(200, {"ok": True, "count": len(payload["messages"])})
            return
        if self.path == "/v1/search":
            self.send_json(
                200,
                {
                    "results": [
                        {
                            "id": "memory-1",
                            "content": f"retrieved: {payload['query']}",
                            "similarity": 0.9,
                            "metadata": {"timestamp": 1_700_000_000_000},
                        }
                    ]
                },
            )
            return
        self.send_json(404, {"error": "not found"})


class RetrieveFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = MockDaemon()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address
        cls.client = retrieve.OpenContextClient(f"http://{host}:{port}", top_k=3)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self) -> None:
        self.server.requests.clear()

    def test_preflight_aggregates_parameter_dataset_and_daemon_failures(self) -> None:
        class FailingClient:
            base_url = "http://127.0.0.1:1"

            @staticmethod
            def health() -> None:
                raise OSError("connection refused")

        with tempfile.TemporaryDirectory() as temp_dir:
            errors = retrieve.collect_preflight_errors(
                "beam",
                Path(temp_dir) / "missing.json",
                Path(temp_dir) / "outputs",
                FailingClient(),
                limit=0,
                samples={"missing-sample"},
                max_questions=0,
            )

        self.assertIn("--limit must be a positive integer", errors)
        self.assertIn("--max-questions must be a positive integer", errors)
        self.assertTrue(any("dataset is missing or unreadable" in error for error in errors))
        self.assertTrue(any("daemon is unavailable" in error for error in errors))

    def test_preflight_rejects_unknown_sample_before_retrieval(self) -> None:
        dataset = HERE.parent / "beam" / "dataset" / "sample_conversation.json"
        with tempfile.TemporaryDirectory() as temp_dir:
            errors = retrieve.collect_preflight_errors(
                "beam",
                dataset,
                Path(temp_dir),
                self.client,
                limit=1,
                samples={"not-present"},
                max_questions=1,
            )

        self.assertEqual(errors, ["unknown --samples value(s): not-present"])

    def fixture_cases(self) -> dict[str, tuple[Path, set[str]]]:
        fixture_root = HERE / "fixtures" / "retrieve"
        return {
            "longmemeval": (
                fixture_root / "longmemeval.json",
                {"id", "question", "question_type", "retrieved_context", "gold_answer"},
            ),
            "locomo": (
                fixture_root / "locomo.json",
                {"id", "question", "category", "retrieved_context", "gold_answer"},
            ),
            "clbench": (
                fixture_root / "clbench.jsonl",
                {"id", "question", "retrieval", "rubrics", "metadata"},
            ),
            "beam": (
                HERE.parent / "beam" / "dataset" / "sample_conversation.json",
                {"id", "question", "category", "retrieved_context", "rubric_nuggets", "scale"},
            ),
            "personamem": (
                fixture_root / "personamem" / "benchmark.csv",
                {
                    "id",
                    "persona_id",
                    "chat_history",
                    "user_query",
                    "correct_answer",
                    "incorrect_answers",
                    "preference",
                },
            ),
            "scriptmem": (
                fixture_root / "scriptmem",
                {
                    "id",
                    "qa_id",
                    "dataset",
                    "question",
                    "qa_type",
                    "speaker_1_name",
                    "speaker_1_memories",
                    "speaker_2_name",
                    "speaker_2_memories",
                },
            ),
        }

    def run_case(self, benchmark: str, dataset: Path, output_root: Path) -> tuple[list[dict], list[str]]:
        self.server.requests.clear()
        self.client.health()
        output = retrieve.run_benchmark(
            benchmark,
            dataset,
            self.client,
            output_root,
            max_questions=1,
        )
        rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]

        add_requests = [payload for path, payload in self.server.requests if path == "/v1/raw-messages"]
        search_requests = [payload for path, payload in self.server.requests if path == "/v1/search"]
        self.assertTrue(add_requests, f"{benchmark} did not ingest fixture messages")
        self.assertTrue(search_requests, f"{benchmark} did not search fixture questions")

        added_user_ids = {payload["userId"] for payload in add_requests}
        for payload in add_requests:
            self.assertTrue(payload["embedOnInsert"])
            for message in payload["messages"]:
                self.assertEqual(payload["userId"], message["userId"])
        for payload in search_requests:
            self.assertIn(payload["userId"], added_user_ids)
            self.assertEqual(payload["limit"], 3)
            self.assertEqual(payload["sources"], ["memory"])

        message_ids = [
            message["messageId"]
            for payload in add_requests
            for message in payload["messages"]
        ]
        self.assertEqual(len(message_ids), len(set(message_ids)))
        return rows, message_ids

    def test_all_six_benchmarks_emit_pipeline_records_over_current_http_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output_root = Path(temp_dir)
            for benchmark, (dataset, required_keys) in self.fixture_cases().items():
                with self.subTest(benchmark=benchmark):
                    first_rows, first_ids = self.run_case(benchmark, dataset, output_root)
                    second_rows, second_ids = self.run_case(benchmark, dataset, output_root)
                    self.assertTrue(first_rows)
                    self.assertTrue(required_keys.issubset(first_rows[0]))
                    self.assertEqual(first_rows, second_rows)
                    self.assertEqual(first_ids, second_ids)

    def test_dataset_and_sample_scopes_are_distinct_and_repeatable(self) -> None:
        first = retrieve.scope_id("beam", Path("beam_1m.json"), "sample-1")
        self.assertEqual(first, retrieve.scope_id("beam", Path("beam_1m.json"), "sample-1"))
        self.assertNotEqual(first, retrieve.scope_id("beam", Path("beam_10m.json"), "sample-1"))
        self.assertNotEqual(first, retrieve.scope_id("beam", Path("beam_1m.json"), "sample-2"))


if __name__ == "__main__":
    unittest.main()
