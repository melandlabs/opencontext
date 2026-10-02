"""Offline fixture and mock HTTP tests for the AML retrieval stage."""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest import mock


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
        self.reranker_ready = True
        self.fail_query = None


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
            self.send_json(200, {"ok": True, "retrieval": {"rerankerReady": self.server.reranker_ready}})
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
        if self.path == "/add":
            self.send_json(200, {"success": True, "request_id": payload["request_id"], "user_id": payload["user_id"], "session_id": payload["session_id"]})
            return
        if self.path == "/search":
            if payload["query"] == self.server.fail_query:
                self.send_json(503, {"error": "simulated search failure"})
                return
            result = {"data": [{"id": "memory-1", "content": f"retrieved: {payload['query']}"}]}
            if self.headers.get("X-OpenContext-Local-Diagnostics") == "1":
                result["_local_diagnostics"] = {
                    "retrieval": {
                        "candidateLimit": 48,
                        "candidateCounts": {"fused": 1, "final": 1},
                        "channels": {
                            "semantic": [{"id": "memory-1", "content": "semantic candidate", "similarity": 0.7}],
                            "lexical": [{"id": "memory-1", "content": "keyword candidate", "similarity": 0.6}],
                            "planner": [{"id": "memory-1", "content": "planner candidate", "similarity": 0.5}],
                        },
                        "fusedBeforeRerank": [{"id": "memory-1", "content": "before rerank", "similarity": 0.4}],
                        "final": [{"id": "memory-1", "content": f"retrieved: {payload['query']}", "similarity": 0.9}],
                        "reranker": {"enabled": True, "provider": "local", "model": "test-model", "inputCount": 1, "outputCount": 1, "latencyMs": 1, "orderChanged": False},
                    },
                    "warnings": [],
                }
            self.send_json(200, result)
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
        cls.aml_client = retrieve.AmlClient(f"http://{host}:{port}", top_k=12)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self) -> None:
        self.server.requests.clear()
        self.server.reranker_ready = True
        self.server.fail_query = None

    def test_beam_reasoning_requires_a_matching_non_degraded_trace(self) -> None:
        client = retrieve.AmlClient(self.aml_client.base_url, top_k=12, reasoning="iterative")
        reply = {
            "data": [{"id": "memory-1", "content": "answer"}],
            "_local_diagnostics": {
                "retrieval": {"fusedBeforeRerank": [], "reranker": {"enabled": True}},
                "reasoning": {"strategy": "iterative", "iterations": 2, "degraded": False},
            },
        }
        with mock.patch.object(client, "_post", return_value=reply) as post:
            hits, diagnostics = client.search_with_diagnostics("user", "question")
        self.assertEqual(hits[0]["id"], "memory-1")
        self.assertEqual(diagnostics["reasoning"]["iterations"], 2)
        self.assertEqual(post.call_args.kwargs["headers"]["X-OpenContext-Local-Reasoning"], "iterative")
        reply["_local_diagnostics"]["reasoning"]["degraded"] = True
        with mock.patch.object(client, "_post", return_value=reply):
            _, degraded = client.search_with_diagnostics("user", "question")
        self.assertTrue(degraded["reasoning"]["degraded"])
        reply["_local_diagnostics"]["reasoning"]["strategy"] = "rewrite"
        with mock.patch.object(client, "_post", return_value=reply):
            with self.assertRaisesRegex(RuntimeError, "did not report"):
                client.search_with_diagnostics("user", "question")

    def test_beam_preflight_requires_ready_reranker(self) -> None:
        self.server.reranker_ready = False
        with self.assertRaisesRegex(RuntimeError, "reranker"):
            self.aml_client.health()

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
        client = self.aml_client if benchmark == "beam" else self.client
        client.health()
        output = retrieve.run_benchmark(
            benchmark,
            dataset,
            client,
            output_root,
            max_questions=1,
        )
        rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]

        add_path, search_path = ("/add", "/search") if benchmark == "beam" else ("/v1/raw-messages", "/v1/search")
        add_requests = [payload for path, payload in self.server.requests if path == add_path]
        search_requests = [payload for path, payload in self.server.requests if path == search_path]
        self.assertTrue(add_requests, f"{benchmark} did not ingest fixture messages")
        self.assertTrue(search_requests, f"{benchmark} did not search fixture questions")

        if benchmark == "beam":
            added_user_ids = {payload["user_id"] for payload in add_requests}
            for payload in add_requests:
                self.assertTrue(all(message["role"] in ("user", "assistant") for message in payload["messages"]))
                self.assertLessEqual(len(payload["messages"]), 20)
            for payload in search_requests:
                self.assertIn(payload["user_id"], added_user_ids)
                self.assertEqual(payload["top_k"], 12)
        else:
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
            message.get("messageId", f"{payload['request_id']}:{index}" if benchmark == "beam" else "")
            for payload in add_requests
            for index, message in enumerate(payload["messages"])
        ]
        self.assertEqual(len(message_ids), len(set(message_ids)))
        return rows, message_ids

    def test_all_six_benchmarks_emit_pipeline_records_over_current_http_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output_root = Path(temp_dir)
            for benchmark, (dataset, required_keys) in self.fixture_cases().items():
                with self.subTest(benchmark=benchmark):
                    first_rows, first_ids = self.run_case(benchmark, dataset, output_root / "first")
                    second_rows, second_ids = self.run_case(benchmark, dataset, output_root / "second")
                    self.assertTrue(first_rows)
                    self.assertTrue(required_keys.issubset(first_rows[0]))
                    self.assertEqual(first_rows, second_rows)
                    self.assertEqual(first_ids, second_ids)

    def test_dataset_and_sample_scopes_are_distinct_and_repeatable(self) -> None:
        first = retrieve.scope_id("beam", Path("beam_1m.json"), "sample-1")
        self.assertEqual(first, retrieve.scope_id("beam", Path("beam_1m.json"), "sample-1"))
        self.assertNotEqual(first, retrieve.scope_id("beam", Path("beam_10m.json"), "sample-1"))
        self.assertNotEqual(first, retrieve.scope_id("beam", Path("beam_1m.json"), "sample-2"))

    def test_beam_preserves_real_dates_and_omits_missing_timestamp(self) -> None:
        messages = retrieve.beam_messages([
            {"speaker": "user", "text": "first", "timestamp": "July-01-2024"},
            {"speaker": "assistant", "text": "second", "timestamp": None},
        ])
        self.assertEqual(messages[0]["timestamp"], 1719792000000)
        self.assertNotIn("timestamp", messages[1])
        chunks = retrieve.beam_add_chunks([{"role": "user", "content": "word"}] * 21)
        self.assertEqual([len(chunk) for chunk in chunks], [20, 1])

    def test_beam_resume_skips_only_committed_add_batches(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            dataset = Path(temp_dir) / "beam_10m.json"
            entry = {
                "entry_id": "sample-1",
                "chat": [
                    {"speaker": "user" if index % 2 == 0 else "assistant", "text": f"message {index}"}
                    for index in range(21)
                ],
                "probing_questions": [{"question_id": "q1", "question": "What happened?"}],
            }
            dataset.write_text(json.dumps({"conversations": [entry]}), encoding="utf-8")
            user_id = retrieve.scope_id("beam", dataset, "sample-1")
            request_id = f"{user_id}:chunk:0"
            saved_ids = {f"aml:{request_id}:{index}" for index in range(20)}
            db = Path(temp_dir) / "saved.db"
            with closing(sqlite3.connect(db)) as connection:
                with connection:
                    connection.execute("CREATE TABLE raw_messages (message_id TEXT, platform TEXT)")
                    connection.executemany(
                        "INSERT INTO raw_messages VALUES (?, 'aml')", [(message_id,) for message_id in saved_ids]
                    )
            loaded_ids = retrieve.load_beam_resume_ids(db)
            output = retrieve.run_benchmark(
                "beam", dataset, self.aml_client, Path(temp_dir) / "outputs", resume_message_ids=loaded_ids
            )
            self.assertEqual(len(retrieve.read_jsonl(output)), 1)
            adds = [body for path, body in self.server.requests if path == "/add"]
            self.assertEqual(len(adds), 1)
            self.assertEqual(adds[0]["request_id"], f"{user_id}:chunk:1")
            self.assertEqual(len(adds[0]["messages"]), 1)
            traces = retrieve.read_jsonl(Path(temp_dir) / "outputs" / "beam" / "retrieval-traces.jsonl")
            self.assertEqual(len(traces), 1)
            self.assertEqual(traces[0]["before_rerank"][0]["content_excerpt"], "before rerank")
            self.assertEqual(traces[0]["after_rerank"][0]["id"], "memory-1")
            self.assertEqual(traces[0]["after_rerank"][0]["retrieval_channels"], ["keyword", "semantic", "planner"])
            self.assertEqual(traces[0]["channel_summary"]["keyword"]["candidate_count"], 1)
            self.assertEqual(traces[0]["channel_summary"]["semantic"]["candidate_count"], 1)
            self.assertEqual(traces[0]["channel_summary"]["planner"]["candidate_count"], 1)
            self.assertTrue(traces[0]["reranker"]["enabled"])

            self.server.requests.clear()
            complete_ids = saved_ids | {f"aml:{user_id}:chunk:1:0"}
            output_again = retrieve.run_benchmark(
                "beam", dataset, self.aml_client, Path(temp_dir) / "outputs", resume_message_ids=complete_ids
            )
            self.assertEqual(retrieve.read_jsonl(output), retrieve.read_jsonl(output_again))
            self.assertFalse([path for path, _ in self.server.requests if path in ("/add", "/search")])

            with self.assertRaisesRegex(ValueError, "partial Add batch"):
                retrieve.completed_beam_add_requests([entry], dataset, {f"aml:{request_id}:0"})
            with self.assertRaisesRegex(ValueError, "non-prefix Add batch"):
                retrieve.completed_beam_add_requests(
                    [entry], dataset, {f"aml:{user_id}:chunk:1:0"}
                )

    def test_beam_finishes_all_adds_before_searching(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            dataset = Path(temp_dir) / "beam.json"
            conversations = [
                {"entry_id": f"entry-{index}", "chat": [{"speaker": "user", "text": f"fact {index}", "source_id": str(index)}],
                 "probing_questions": [{"question_id": f"q-{index}", "question": f"question {index}", "source": {"source_chat_ids": [str(index)]}}]}
                for index in range(2)
            ]
            dataset.write_text(json.dumps({"conversations": conversations}), encoding="utf-8")
            retrieve.run_benchmark("beam", dataset, self.aml_client, Path(temp_dir) / "outputs")
            self.assertEqual([path for path, _ in self.server.requests], ["/add", "/add", "/search", "/search"])
            self.assertEqual(len(retrieve.read_jsonl(Path(temp_dir) / "outputs" / "beam" / "retrieval-traces.jsonl")), 2)

    def test_beam_resumes_after_a_search_failure_without_repeating_completed_question(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            dataset = Path(temp_dir) / "beam.json"
            entry = {"entry_id": "entry-1", "chat": [{"speaker": "user", "text": "fact"}],
                     "probing_questions": [{"question_id": "q-1", "question": "first"}, {"question_id": "q-2", "question": "second"}]}
            dataset.write_text(json.dumps({"conversations": [entry]}), encoding="utf-8")
            output_root = Path(temp_dir) / "outputs"
            self.server.fail_query = "second"
            with self.assertRaises(urllib.error.HTTPError):
                retrieve.run_benchmark("beam", dataset, self.aml_client, output_root)
            result_dir = output_root / "beam"
            self.assertEqual(len(list((result_dir / "retrieval-checkpoints").glob("*.json"))), 1)
            self.assertFalse((result_dir / "input.jsonl").exists())

            self.server.fail_query = None
            self.server.requests.clear()
            user_id = retrieve.scope_id("beam", dataset, "entry-1")
            saved_ids = {f"aml:{user_id}:chunk:0:0"}
            output = retrieve.run_benchmark("beam", dataset, self.aml_client, output_root, resume_message_ids=saved_ids)
            self.assertEqual(len(retrieve.read_jsonl(output)), 2)
            self.assertEqual([body["query"] for path, body in self.server.requests if path == "/search"], ["second"])
            self.assertFalse([path for path, _ in self.server.requests if path == "/add"])

    def test_beam_evidence_previews_original_text_but_hashes_full_context(self) -> None:
        content = (
            "[Message order guidance]\n" + "Guidance. " * 60
            + "\n\n[Message metadata]\nmessageSequence: 9"
            + "\n\n[Original excerpt]\nA 50-page album costs $75."
        )
        evidence = retrieve.beam_hit_evidence(
            {"id": "m1", "content": content}, 1, {"m1": "turn-7"}, {"turn-7"}
        )
        self.assertEqual(evidence["content_excerpt"], "A 50-page album costs $75.")
        self.assertEqual(
            evidence["content_sha256"], retrieve.hashlib.sha256(content.encode()).hexdigest()
        )
        self.assertEqual(evidence["matched_source_turn_ids"], ["turn-7"])

    def test_beam_hit_evidence_maps_exact_source_id(self) -> None:
        hit = {"id": "aml:request:0", "content": "answer", "similarity": 0.5}
        evidence = retrieve.beam_hit_evidence(hit, 1, {"aml:request:0": "turn-7"}, {"turn-7"})
        self.assertEqual(evidence["source_turn_ids"], ["turn-7"])
        self.assertEqual(evidence["matched_source_turn_ids"], ["turn-7"])

    def test_socket_10055_is_retried_before_aborting_add(self) -> None:
        actual_urlopen = retrieve.urllib.request.urlopen
        attempts = 0

        def flaky_urlopen(request: Any, timeout: int) -> Any:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise urllib.error.URLError(OSError(10055, "no socket buffer"))
            return actual_urlopen(request, timeout=timeout)

        with mock.patch.object(retrieve.urllib.request, "urlopen", side_effect=flaky_urlopen):
            with mock.patch.object(retrieve.time, "sleep") as sleep:
                self.aml_client.add("request-1", "user-1", "session-1", [{"role": "user", "content": "hello"}])
        self.assertEqual(attempts, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(len([path for path, _ in self.server.requests if path == "/add"]), 1)

    def test_clbench_single_message_splits_inline_context_and_task(self) -> None:
        row = {
            "metadata": {"task_id": "inline-task"},
            "messages": [
                {
                    "role": "user",
                    "content": "Historical note: I use a standing desk.\n<|TASK|> What kind of desk do I use?",
                }
            ],
            "rubrics": ["Mentions a standing desk."],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            dataset = Path(temp_dir) / "CL-bench-Life.jsonl"
            dataset.write_text(json.dumps(row) + "\n", encoding="utf-8")
            output = retrieve.run_benchmark("clbench", dataset, self.client, Path(temp_dir) / "outputs")

            result = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result["question"], "What kind of desk do I use?")

        add_requests = [payload for path, payload in self.server.requests if path == "/v1/raw-messages"]
        search_requests = [payload for path, payload in self.server.requests if path == "/v1/search"]
        self.assertEqual(add_requests[0]["messages"][0]["content"], "User: Historical note: I use a standing desk.")
        self.assertEqual(search_requests[0]["query"], "What kind of desk do I use?")


if __name__ == "__main__":
    unittest.main()
