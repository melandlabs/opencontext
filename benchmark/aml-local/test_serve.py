"""Focused public Add/Search contract checks without an external daemon."""
from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("aml_local_serve", Path(__file__).with_name("serve.py"))
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load serve.py")
serve = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = serve
SPEC.loader.exec_module(serve)


class AdapterContractTests(unittest.TestCase):
    def test_add_preserves_order_roles_and_only_supplied_timestamps(self) -> None:
        body = {
            "request_id": "req-1", "user_id": "user-1", "session_id": "session-1",
            "messages": [
                {"role": "user", "content": "first", "timestamp": 0},
                {"role": "assistant", "content": "second"},
            ],
        }
        with patch.object(serve, "oc_post", return_value={"ok": True, "count": 2}) as post:
            self.assertEqual(serve.handle_add(body), {
                "success": True, "request_id": "req-1", "user_id": "user-1", "session_id": "session-1"
            })
        path, payload = post.call_args.args
        self.assertEqual(path, "/v1/raw-messages")
        self.assertTrue(payload["embedOnInsert"])
        first, second = payload["messages"]
        self.assertEqual([first["content"], second["content"]], ["first", "second"])
        self.assertEqual([first["messageId"], second["messageId"]], ["aml:req-1:0", "aml:req-1:1"])
        self.assertEqual(first["metadata"], {"role": "user", "sessionId": "session-1"})
        self.assertEqual(second["metadata"], {"role": "assistant", "sessionId": "session-1"})
        self.assertEqual(first["timestamp"], 0)
        self.assertNotIn("timestamp", second)
        self.assertLess(first["createdAt"], 100_000_000_000)  # OpenContext uses epoch seconds.

    def test_add_rejects_missing_role_and_invalid_content_before_writing(self) -> None:
        for message in ({"content": "text"}, {"role": "user", "content": ""}):
            with self.subTest(message=message), patch.object(serve, "oc_post") as post:
                with self.assertRaises(ValueError):
                    serve.handle_add({
                        "request_id": "req", "user_id": "user", "session_id": "session", "messages": [message]
                    })
                post.assert_not_called()

    def test_add_accepts_a_batch_the_daemon_only_warned_about(self) -> None:
        # A warning means "written, but the write could not be enriched"
        # (for example the embedding provider was unreachable). The messages
        # are persisted and the lexical channel still finds them, so the
        # batch is acknowledged: refusing it would make the platform retry a
        # request that can never succeed, and a rejected batch scores nothing.
        body = {"request_id": "req", "user_id": "user", "session_id": "session",
                "messages": [{"role": "user", "content": "text"}]}
        with patch.object(serve, "oc_post", return_value={"ok": True, "count": 1, "warnings": [{"code": "semantic_unavailable"}]}):
            result = serve.handle_add(body)
        self.assertTrue(result["success"])

    def test_add_fails_when_the_daemon_did_not_accept_the_write(self) -> None:
        body = {"request_id": "req", "user_id": "user", "session_id": "session",
                "messages": [{"role": "user", "content": "text"}]}
        with patch.object(serve, "oc_post", return_value={"ok": False, "count": 0}):
            with self.assertRaises(RuntimeError):
                serve.handle_add(body)

    def test_add_without_a_request_id_still_keys_the_batch_by_content(self) -> None:
        # An empty request_id would collapse every sample onto `aml::0`,
        # `aml::1`, ... and later batches would overwrite earlier ones.
        body = {"user_id": "user", "session_id": "session",
                "messages": [{"role": "user", "content": "text"}]}
        with patch.object(serve, "oc_post", return_value={"ok": True, "count": 1}) as post:
            serve.handle_add(body)
        first_id = post.call_args.args[1]["messages"][0]["messageId"]
        self.assertTrue(first_id.startswith("aml:content-"), first_id)
        with patch.object(serve, "oc_post", return_value={"ok": True, "count": 1}) as post:
            serve.handle_add(body)
        self.assertEqual(post.call_args.args[1]["messages"][0]["messageId"], first_id)
        # A different batch gets a different key.
        other = dict(body, messages=[{"role": "user", "content": "other"}])
        with patch.object(serve, "oc_post", return_value={"ok": True, "count": 1}) as post:
            serve.handle_add(other)
        self.assertNotEqual(post.call_args.args[1]["messages"][0]["messageId"], first_id)

    def test_search_keeps_relevance_order_and_respects_top_k(self) -> None:
        hits = [
            {"id": "new", "content": "newer", "similarity": 0.6,
             "metadata": {"messageSequence": 2, "rerankerScore": 0.9}},
            {"id": "old", "content": "older", "similarity": 0.8,
             "metadata": {"messageSequence": 1, "rerankerScore": 0.5}},
        ]
        with patch.object(serve, "oc_post", return_value={"results": hits}) as post:
            result = serve.handle_search({"query": "what?", "user_id": "user", "top_k": 100})
        self.assertEqual([item["id"] for item in result["data"]], ["new", "old"])
        self.assertEqual([item["score"] for item in result["data"]], [0.9, 0.5])
        self.assertEqual(post.call_args.args[1]["limit"], 100)
        with patch.object(serve, "oc_post", return_value={"results": hits}):
            with self.assertRaises(RuntimeError):
                serve.handle_search({"query": "what?", "user_id": "user", "top_k": 1})

    def test_local_diagnostics_uses_same_search_without_changing_public_response(self) -> None:
        hit = {"id": "memory-1", "content": "answer", "similarity": 0.8}
        diagnostics = {"fusedBeforeRerank": [hit], "reranker": {"enabled": True, "model": "test"}, "final": [hit]}
        with patch.object(serve, "oc_post", return_value={"results": [hit], "retrievalDiagnostics": diagnostics}) as post:
            result = serve.handle_search({"query": "what?", "user_id": "user", "top_k": 12,}, local_diagnostics=True)
        self.assertEqual(result["data"][0]["id"], "memory-1")
        self.assertEqual(result["_local_diagnostics"]["retrieval"], diagnostics)
        self.assertTrue(post.call_args.args[1]["includeRetrievalDiagnostics"])
        with patch.object(serve, "oc_post", return_value={"results": [hit], "retrievalDiagnostics": diagnostics}) as post:
            public = serve.handle_search({"query": "what?", "user_id": "user", "top_k": 12})
        self.assertEqual(list(public), ["data"])
        self.assertNotIn("includeRetrievalDiagnostics", post.call_args.args[1])

    def test_local_reasoning_is_explicit_and_does_not_change_public_search(self) -> None:
        hit = {"id": "memory-1", "content": "answer", "similarity": 0.8}
        diagnostics = {"fusedBeforeRerank": [hit], "reranker": {"enabled": True}, "final": [hit]}
        core = {
            "results": [hit],
            "retrievalDiagnostics": diagnostics,
            "reasoning": {"strategy": "rewrite", "rewrittenQueries": ["original", "rewritten"]},
        }
        body = {"query": "what?", "user_id": "user", "top_k": 12}
        with patch.object(serve, "oc_post", return_value=core) as post:
            result = serve.handle_search(body, local_diagnostics=True, local_reasoning="rewrite")
        self.assertEqual(result["_local_diagnostics"]["reasoning"]["strategy"], "rewrite")
        self.assertEqual(post.call_args.args[1]["reasoningStrategy"], "rewrite")
        with patch.object(serve, "oc_post") as post:
            with self.assertRaisesRegex(ValueError, "requires local diagnostics"):
                serve.handle_search(body, local_reasoning="rewrite")
            post.assert_not_called()

    def test_local_union_uses_existing_core_strategy_without_changing_public_body(self) -> None:
        hit = {"id": "memory-1", "content": "answer", "similarity": 0.8}
        diagnostics = {"fusedBeforeRerank": [hit], "reranker": {"enabled": True}, "final": [hit]}
        core = {"results": [hit], "retrievalDiagnostics": diagnostics,
                "reasoning": {"strategy": "union", "iterations": 2, "evidenceCount": 1}}
        body = {"query": "what?", "user_id": "user", "top_k": 12}
        with patch.object(serve, "oc_post", return_value=core) as post:
            result = serve.handle_search(body, local_diagnostics=True, local_reasoning="union")
        self.assertEqual(result["data"], [{"id": "memory-1", "content": "answer", "score": 0.8}])
        self.assertEqual(result["_local_diagnostics"]["reasoning"]["strategy"], "union")
        self.assertEqual(post.call_args.args[1]["reasoningStrategy"], "union")
        self.assertEqual(body, {"query": "what?", "user_id": "user", "top_k": 12})


class SessionNeighborExpansionTests(unittest.TestCase):
    """The expansion is an explicit experiment, off in the submitted run."""

    def test_it_is_off_by_default(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AML_SESSION_NEIGHBOR_EXPANSION", None)
            self.assertIsNone(serve.session_neighbor_expansion())

    def test_the_off_values_are_honoured(self) -> None:
        for value in ("", "off", "0", "false", "none"):
            with patch.dict(os.environ, {"AML_SESSION_NEIGHBOR_EXPANSION": value}, clear=False):
                self.assertIsNone(serve.session_neighbor_expansion())

    def test_an_unknown_mode_is_rejected(self) -> None:
        with patch.dict(os.environ, {"AML_SESSION_NEIGHBOR_EXPANSION": "sometimes"}, clear=False):
            with self.assertRaises(ValueError):
                serve.session_neighbor_expansion()

    def test_the_expansion_reaches_the_daemon_only_when_it_is_enabled(self) -> None:
        hit = {"id": "memory-1", "content": "answer", "similarity": 0.8}
        body = {"query": "what?", "user_id": "user", "top_k": 12}
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AML_SESSION_NEIGHBOR_EXPANSION", None)
            with patch.object(serve, "oc_post", return_value={"results": [hit]}) as post:
                serve.handle_search(body)
            self.assertNotIn("sessionNeighborExpansion", post.call_args.args[1])
        with patch.dict(os.environ, {"AML_SESSION_NEIGHBOR_EXPANSION": "protected"}, clear=False):
            with patch.object(serve, "oc_post", return_value={"results": [hit]}) as post:
                serve.handle_search(body)
            expansion = post.call_args.args[1]["sessionNeighborExpansion"]
            self.assertEqual(expansion["mode"], "protected")
            self.assertGreaterEqual(expansion["window"], 1)


if __name__ == "__main__":
    unittest.main()
