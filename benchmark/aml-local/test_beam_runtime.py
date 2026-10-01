"""Fault injection for resumable BEAM execution; no paid model requests."""
import argparse
import asyncio
import json
import os
import runpy
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import httpx
import beam_runtime


HERE = Path(__file__).resolve().parent
CLIENT = httpx.AsyncClient


def response(content="answer", status=200, finish="stop"):
    return httpx.Response(status, json={"provider": "test-provider", "model": "test-model",
        "choices": [{"message": {"content": content}, "finish_reason": finish}]})


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.official = runpy.run_path(str(HERE.parent / "AML-agent-memory-leaderboard/data/beam/pipeline.py"), run_name="_test_beam")
        self.inputs = self.root / "input.jsonl"
        self.answers = self.root / "answers.jsonl"
        self.judged = self.root / "judged.jsonl"
        self.items = [{"id": "q1", "question": "first question?", "retrieved_context": ["context"],
                       "rubric_nuggets": ["fact"], "category": "information_extraction"},
                      {"id": "q2", "question": "second question?", "retrieved_context": ["context"],
                       "rubric_nuggets": ["fact"], "category": "information_extraction"}]
        self.save(self.inputs, self.items)
        env = {"ANSWER_MODEL": "deepseek/deepseek-v4-flash-0731", "JUDGE_MODEL": "qwen/qwen3.8-flash",
               "ANSWER_API_BASE": "https://openrouter.ai/api/v1", "JUDGE_API_BASE": "https://openrouter.ai/api/v1",
               "ANSWER_API_KEY": "test-key", "JUDGE_API_KEY": "test-key", "AML_BEAM_REQUEST_ATTEMPTS": "3",
               "AML_BEAM_REQUEST_TIMEOUT": "0.2", "AML_BEAM_HEARTBEAT_SECONDS": "0.03"}
        env.update({key: value for key, value in os.environ.items()
                    if key.upper() in {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"}})
        self.env = patch.dict(os.environ, env, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        async def no_sleep(_delay):
            pass
        self.sleep_patch = patch.object(beam_runtime, "retry_sleep", no_sleep)
        self.sleep_patch.start()
        self.addCleanup(self.sleep_patch.stop)

    def save(self, path, rows):
        path.write_text("".join(json.dumps(x) + "\n" for x in rows), encoding="utf-8")

    def read(self, path):
        return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines()]

    def runtime(self, stage="answer"):
        args = argparse.Namespace(input=str(self.inputs), output=str(self.answers if stage == "answer" else self.judged))
        if stage == "answer":
            args.max_tokens = 512
        else:
            args.answers, args.judge_max_tokens = str(self.answers), 1024
        return beam_runtime.BeamRuntime(self.official, args)

    def execute(self, handler, stage="answer"):
        runtime = self.runtime(stage)
        def client(**_kwargs):
            return CLIENT(transport=httpx.MockTransport(handler))
        with patch.object(beam_runtime.httpx, "AsyncClient", client):
            code = asyncio.run(runtime.run())
        return code, runtime

    def test_answer_failure_does_not_stop_later_question_and_resume_only_retries_missing(self):
        calls = []
        def fail_first(request):
            content = json.loads(request.content)["messages"][0]["content"]
            calls.append(content)
            if "first question?" in content:
                raise httpx.ReadTimeout("connection stalled")
            return response()
        code, runtime = self.execute(fail_first)
        self.assertEqual(code, 2)
        self.assertEqual(len(calls), 4)
        self.assertEqual([x["id"] for x in self.read(self.answers)], ["q2"])
        self.assertEqual(self.read(runtime.errors)[0]["id"], "q1")
        self.assertEqual(json.loads(runtime.status_path.read_text())["pending_ids"], ["q1"])
        calls.clear()
        def succeed(request):
            calls.append(request)
            return response("recovered")
        code, _ = self.execute(succeed)
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(self.read(self.answers)), 2)

    def test_empty_http_error_and_invalid_json_are_bounded(self):
        for kind in ("empty", "server", "rate_limit", "json"):
            with self.subTest(kind=kind):
                self.answers.unlink(missing_ok=True)
                calls = []
                def broken(request):
                    calls.append(request)
                    if kind == "empty": return response(None)
                    if kind == "server": return response(status=503)
                    if kind == "rate_limit": return response(status=429)
                    return httpx.Response(200, text="not json")
                code, _ = self.execute(broken)
                self.assertEqual(code, 2)
                self.assertEqual(len(calls), 6)
                self.assertEqual(self.read(self.answers), [])

    def test_raw_tls_failure_retries_then_recovers(self):
        calls = []
        def handler(request):
            calls.append(request)
            if len(calls) == 1:
                raise ssl.SSLError(1, "[SSL: DECRYPTION_FAILED_OR_BAD_RECORD_MAC] bad record mac")
            return response()
        code, runtime = self.execute(handler)
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 3)
        audit = self.read(runtime.requests_path)
        self.assertIn("SSLError", audit[0]["error"])
        self.assertEqual(audit[1]["attempt"], 2)
        self.assertEqual(len(self.read(self.answers)), 2)

    def test_rate_limit_backoff_and_retry_after(self):
        def error(status=429, headers=None):
            reply = httpx.Response(status, headers=headers, request=httpx.Request("POST", "https://example.com"))
            return httpx.HTTPStatusError("limited", request=reply.request, response=reply)
        self.assertEqual(beam_runtime.retry_delay(error(), 1), 15)
        self.assertEqual(beam_runtime.retry_delay(error(), 2), 30)
        self.assertEqual(beam_runtime.retry_delay(error(headers={"Retry-After": "45"}), 1), 45)
        self.assertEqual(beam_runtime.retry_delay(error(headers={"Retry-After": "invalid"}), 1), 15)
        self.assertEqual(beam_runtime.retry_delay(error(headers={"Retry-After": "9999"}), 1), 300)
        self.assertEqual(beam_runtime.retry_delay(error(503), 1), 2)
        self.assertEqual(beam_runtime.retry_delay(httpx.ReadTimeout("timeout"), 2), 4)

    def test_persistent_raw_network_errors_skip_only_affected_question(self):
        for exception in (ssl.SSLError(1, "bad record mac"), ConnectionResetError(10054, "reset"), OSError(10055, "socket buffers exhausted")):
            with self.subTest(exception=type(exception).__name__):
                self.answers.unlink(missing_ok=True)
                calls = []
                def handler(request):
                    calls.append(request)
                    if "first question?" in json.loads(request.content)["messages"][0]["content"]:
                        raise exception
                    return response()
                code, runtime = self.execute(handler)
                self.assertEqual(code, 2)
                self.assertEqual(len(calls), 4)
                self.assertEqual([r["id"] for r in self.read(self.answers)], ["q2"])
                self.assertEqual(runtime.state["pending_ids"], ["q1"])

    def test_filesystem_errors_are_not_misclassified_as_network_retries(self):
        calls = []
        def handler(request):
            calls.append(request)
            return response()
        with patch.object(beam_runtime, "append_json", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.execute(handler)
        self.assertEqual(len(calls), 1)

    def test_truncation_is_retried_and_official_prompt_is_preserved(self):
        payloads = []
        def handler(request):
            payload = json.loads(request.content)
            payloads.append(payload)
            if len(payloads) == 1: return response("partial", finish="length")
            return response("complete")
        code, runtime = self.execute(handler)
        self.assertEqual(code, 0)
        self.assertEqual([p["max_tokens"] for p in payloads], [512, 2048, 512])
        self.assertEqual(payloads[0]["messages"][0]["content"], self.official["render_answer_prompt"](self.items[0]))
        self.assertTrue(all(p["model"] == os.environ["ANSWER_MODEL"] for p in payloads))
        self.assertEqual(self.read(runtime.requests_path)[0]["finish_reason"], "length")

    def test_common_reasoning_flag_applies_to_answer_and_judge(self):
        os.environ["AML_DISABLE_PROVIDER_REASONING"] = "1"
        payloads = []
        def handler(request):
            payload = json.loads(request.content)
            payloads.append(payload)
            if payload.get("response_format"):
                return response('{"scores":[{"index":0,"score":1,"reason":"ok"}]}')
            return response("answer")
        answer_code, _ = self.execute(handler)
        judge_code, _ = self.execute(handler, "evaluate")
        self.assertEqual((answer_code, judge_code), (0, 0))
        self.assertEqual(len(payloads), 4)
        self.assertTrue(all(payload["reasoning"] == {"effort": "none"} for payload in payloads))

    def test_judge_format_failure_continues_and_missing_answer_is_not_fabricated(self):
        self.save(self.answers, [{"id": x["id"], "generated_answer": "answer"} for x in self.items])
        calls = []
        def handler(request):
            payload = json.loads(request.content)
            calls.append(payload)
            if "first question?" in payload["messages"][0]["content"]: return response('{"score": 1}')
            return response('{"scores":[{"index":0,"score":1,"reason":"ok"}]}')
        code, _ = self.execute(handler, "evaluate")
        self.assertEqual(code, 2)
        self.assertEqual(len(calls), 4)
        self.assertTrue(all("provider" not in p for p in calls))
        self.assertEqual([r["id"] for r in self.read(self.judged)], ["q2"])
        self.save(self.answers, [{"id": "q2", "generated_answer": "answer"}])
        calls.clear()
        code, runtime = self.execute(handler, "evaluate")
        self.assertEqual(calls, [])
        self.assertEqual(runtime.state["missing_answers"], 1)

    def test_event_alignment_failure_is_not_a_zero_score_and_next_question_runs(self):
        self.items[0]["category"] = "event_ordering"
        self.save(self.inputs, self.items)
        self.save(self.answers, [{"id": x["id"], "generated_answer": "answer"} for x in self.items])
        events = []
        def handler(request):
            payload = json.loads(request.content)
            if len(payload["messages"]) == 2:
                events.append(payload)
                return response(None)
            return response('{"scores":[{"index":0,"score":1,"reason":"ok"}]}')
        code, _ = self.execute(handler, "evaluate")
        self.assertEqual(code, 2)
        self.assertEqual(len(events), 3)
        self.assertEqual(events[0]["max_tokens"], 8)
        self.assertEqual(events[0]["reasoning"], {"effort": "none"})
        self.assertEqual([r["id"] for r in self.read(self.judged)], ["q2"])

    def test_partial_event_judgement_resumes_saved_subrequests(self):
        self.items[0]["category"] = "event_ordering"
        self.save(self.inputs, self.items)
        self.save(self.answers, [{"id": x["id"], "generated_answer": "first\nsecond"} for x in self.items])
        events = []
        def first_run(request):
            payload = json.loads(request.content)
            if len(payload["messages"]) == 2:
                events.append(payload)
                if len(events) == 1:
                    return response("NO")
                return response(status=503)
            return response('{"scores":[{"index":0,"score":1,"reason":"ok"}]}')
        code, _ = self.execute(first_run, "evaluate")
        self.assertEqual(code, 2)
        calls = []
        def resume(request):
            payload = json.loads(request.content)
            calls.append(payload)
            self.assertEqual(len(payload["messages"]), 2)
            self.assertNotEqual(payload, events[0])
            return response("YES")
        code, _ = self.execute(resume, "evaluate")
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(self.read(self.judged)), 2)

    def test_wait_has_heartbeat_and_wall_clock_timeout(self):
        async def handler(_request):
            await asyncio.sleep(1)
            return response()
        code, runtime = self.execute(handler)
        self.assertEqual(code, 2)
        self.assertIn("waiting", runtime.log_path.read_text())
        self.assertIn("TimeoutError", runtime.log_path.read_text())

    def test_changed_model_cannot_mix_with_existing_answers(self):
        self.execute(lambda request: response())
        with patch.dict(os.environ, {"ANSWER_MODEL": "different-model"}):
            with self.assertRaisesRegex(ValueError, "model differs"):
                self.execute(lambda request: response())

    def test_official_scoring_and_event_matching_success(self):
        self.items[0]["category"] = "event_ordering"
        self.save(self.inputs, self.items)
        self.save(self.answers, [{"id": x["id"], "generated_answer": "fact"} for x in self.items])
        def handler(request):
            payload = json.loads(request.content)
            if len(payload["messages"]) == 2: return response("YES")
            return response('{"scores":[{"index":0,"score":0.5,"reason":"partial"}]}')
        code, _ = self.execute(handler, "evaluate")
        self.assertEqual(code, 0)
        result = self.read(self.judged)[0]
        self.assertEqual(result["llm_judge_score"], 0.5)
        self.assertEqual(result["event_ordering"], self.official["event_ordering_metrics"](["fact"], ["fact"]))

    def test_cli_partial_answer_evaluate_then_resume_to_complete(self):
        control = {"fail_first": True}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                fail = control["fail_first"] and "first question?" in payload["messages"][0]["content"]
                content = '{"scores":[{"index":0,"score":1,"reason":"ok"}]}' if "response_format" in payload else "answer"
                data = json.dumps({"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}).encode()
                self.send_response(503 if fail else 200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            env = dict(os.environ, ANSWER_API_BASE=f"http://127.0.0.1:{server.server_port}",
                       JUDGE_API_BASE=f"http://127.0.0.1:{server.server_port}",
                       AML_BEAM_REQUEST_ATTEMPTS="1", AML_BEAM_REQUEST_TIMEOUT="5",
                       AML_PUBLIC_BEAM_FLOW="0", PYTHONIOENCODING="utf-8")
            def run(stage):
                command = [sys.executable, str(HERE / "run_pipeline.py"),
                           str(HERE.parent / "AML-agent-memory-leaderboard/data/beam/pipeline.py"),
                           stage, "--input", str(self.inputs), "--output", str(self.answers if stage == "answer" else self.judged)]
                if stage == "evaluate": command += ["--answers", str(self.answers)]
                return subprocess.run(command, env=env, capture_output=True, text=True, encoding="utf-8", timeout=20)
            for stage in ("answer", "evaluate"):
                result = run(stage)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            control["fail_first"] = False
            for stage in ("answer", "evaluate"):
                result = run(stage)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(self.read(self.answers)), 2)
            self.assertEqual(len(self.read(self.judged)), 2)
            status = json.loads(self.judged.with_name("judged-status.json").read_text())
            self.assertEqual(status["status"], "complete")
            self.assertEqual(status["mean_score_on_scored_questions"], 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
