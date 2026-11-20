"""Gate-check behaviour: a healthy deployment passes, a broken one does not."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("aml_local_gate_check", Path(__file__).with_name("gate_check.py"))
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load gate_check.py")
gate_check = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = gate_check
SPEC.loader.exec_module(gate_check)


CANARY = "zqxkcanarydeadbeef"


def healthy_daemon_health() -> dict:
    return {
        "ok": True,
        "retrieval": {
            "backend": "sqlite-vec",
            "embeddingProvider": "local",
            "embeddingModel": "Xenova/all-MiniLM-L6-v2",
            "embeddingDimensions": 384,
            "childCount": 12,
            "embeddedChildCount": 12,
            "indexedDimensions": [384],
            "indexedEmbeddingModels": ["Xenova/all-MiniLM-L6-v2"],
            "semanticReady": True,
            "lexicalReady": True,
            "semanticDegradedReason": None,
            "rerankerProvider": "local",
            "rerankerModel": "Xenova/ms-marco-MiniLM-L-6-v2",
            "rerankerReady": True,
        },
    }


class GateCheckTests(unittest.TestCase):
    def make_checker(self, daemon_health: dict, search_results: list | None = None) -> gate_check.Checker:
        checker = gate_check.Checker("http://adapter", "http://daemon", 5, False)
        search_results = search_results if search_results is not None else []

        def fake_request(method: str, url: str, payload: dict | None = None):
            if method == "GET" and url.endswith("/health"):
                if "daemon" in url:
                    return 200, daemon_health
                return 200, {"ok": True}
            if method == "POST" and url.endswith("/add"):
                return 200, {"success": True}
            if method == "POST" and url.endswith("/search"):
                user_id = (payload or {}).get("user_id", "")
                if "other" in user_id:
                    return 200, {"data": []}
                return 200, {"data": list(search_results)}
            return 404, {"error": "not found"}

        checker.request = fake_request  # type: ignore[method-assign]
        checker.sleep = lambda _seconds: None  # type: ignore[assignment]
        return checker

    def test_a_healthy_deployment_passes_every_gate(self) -> None:
        checker = self.make_checker(
            healthy_daemon_health(),
            [{"id": "m1", "content": f"[2026-01-01 00:00] user: The access code is {CANARY}.", "score": 0.9}],
        )
        # The canary token in the fake result has to match the one the checker
        # generates, so patch the uuid source to a fixed value.
        original = gate_check.uuid.uuid4
        gate_check.uuid.uuid4 = lambda: type("U", (), {"hex": "deadbeef00000000"})()  # type: ignore[assignment]
        try:
            checker.check_adapter_health()
            retrieval = checker.check_daemon_retrieval()
            checker.check_lexical(retrieval)
            checker.check_reranker(retrieval)
            checker.check_round_trip()
            checker.check_semantic(retrieval)
            checker.check_top_k()
            checker.check_concurrency(4)
        finally:
            gate_check.uuid.uuid4 = original  # type: ignore[assignment]
        failures = [result for result in checker.results if not result["ok"]]
        self.assertEqual(failures, [], failures)

    def test_a_disabled_reranker_fails_the_gate(self) -> None:
        health = healthy_daemon_health()
        health["retrieval"]["rerankerReady"] = False
        checker = self.make_checker(health)
        checker.check_reranker(checker.check_daemon_retrieval())
        self.assertFalse(checker.results[-1]["ok"])

    def test_the_reranker_gate_can_be_waived_for_ablations(self) -> None:
        health = healthy_daemon_health()
        health["retrieval"]["rerankerReady"] = False
        checker = gate_check.Checker("http://adapter", "http://daemon", 5, True)
        checker.request = self.make_checker(health).request  # type: ignore[method-assign]
        checker.check_reranker(checker.check_daemon_retrieval())
        self.assertTrue(checker.results[-1]["ok"])

    def test_an_index_written_by_another_model_is_reported(self) -> None:
        health = healthy_daemon_health()
        health["retrieval"]["indexedEmbeddingModels"] = ["Xenova/bge-small-en"]
        checker = self.make_checker(health)
        checker.check_semantic(checker.check_daemon_retrieval())
        gates = {result["gate"]: result["ok"] for result in checker.results}
        self.assertFalse(gates["embedding_model_matches_index"])
        self.assertFalse(gates["semantic_ready"])

    def test_a_mixed_index_is_reported_even_when_the_running_model_is_in_it(self) -> None:
        health = healthy_daemon_health()
        health["retrieval"]["indexedEmbeddingModels"] = [
            "Xenova/all-MiniLM-L6-v2",
            "Xenova/bge-small-en",
        ]
        checker = self.make_checker(health)
        checker.check_semantic(checker.check_daemon_retrieval())
        gates = {result["gate"]: result["ok"] for result in checker.results}
        self.assertFalse(gates["embedding_model_matches_index"])
        self.assertFalse(gates["semantic_ready"])

    def test_the_semantic_gate_waits_for_the_first_embedding_to_land(self) -> None:
        """A cold deployment embeds the first chunk asynchronously.

        The gate must not call that broken: it polls until the vectors show
        up (or the timeout is over).
        """
        cold = healthy_daemon_health()
        cold["retrieval"].update(
            {
                "childCount": 1,
                "embeddedChildCount": 0,
                "indexedDimensions": [],
                "indexedEmbeddingModels": [],
                "semanticReady": False,
                "semanticDegradedReason": "semantic_child_vectors_empty",
            }
        )
        checker = self.make_checker(cold)
        calls = {"health": 0}

        def fake_request(method: str, url: str, payload: dict | None = None):
            if method == "GET" and url.endswith("/health") and "daemon" in url:
                calls["health"] += 1
                if calls["health"] > 2:
                    return 200, healthy_daemon_health()
                return 200, cold
            if method == "GET" and url.endswith("/health"):
                return 200, {"ok": True}
            if method == "POST" and url.endswith("/add"):
                return 200, {"success": True}
            if method == "POST" and url.endswith("/search"):
                return 200, {"data": []}
            return 404, {"error": "not found"}

        checker.request = fake_request  # type: ignore[method-assign]
        checker.check_semantic(checker.check_daemon_retrieval())
        gates = {result["gate"]: result["ok"] for result in checker.results}
        self.assertTrue(gates["semantic_ready"], checker.results)
        self.assertGreater(calls["health"], 1)

    def test_a_canary_that_cannot_be_found_fails_the_round_trip(self) -> None:
        checker = self.make_checker(healthy_daemon_health(), [])
        checker.check_round_trip()
        gates = {result["gate"]: result["ok"] for result in checker.results}
        self.assertFalse(gates["round_trip_add_search"])

    def test_evidence_without_a_date_fails_the_evidence_gate(self) -> None:
        checker = self.make_checker(
            healthy_daemon_health(),
            [{"id": "m1", "content": f"The access code is {CANARY}.", "score": 0.9}],
        )
        original = gate_check.uuid.uuid4
        gate_check.uuid.uuid4 = lambda: type("U", (), {"hex": "deadbeef00000000"})()  # type: ignore[assignment]
        try:
            checker.check_round_trip()
        finally:
            gate_check.uuid.uuid4 = original  # type: ignore[assignment]
        gates = {result["gate"]: result["ok"] for result in checker.results}
        self.assertFalse(gates["evidence_is_dated_and_attributed"])


if __name__ == "__main__":
    unittest.main()
