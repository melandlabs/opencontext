"""Checks that BEAM report metrics keep each evidence stage distinct."""
import json
import tempfile
import unittest
from pathlib import Path

from analyze_beam_run import evidence_chain, provider_audit


class EvidenceChainTests(unittest.TestCase):
    def test_source_loss_and_answer_score_are_reported_separately(self):
        traces = {
            "q1": {
                "required_source_turn_ids": ["a", "b"],
                "available_required_source_turn_ids": ["a", "b"],
                "channels": {
                    "keyword": [{"matched_source_turn_ids": ["a"]}],
                    "semantic": [{"matched_source_turn_ids": ["b"]}],
                },
                "before_rerank": [{"matched_source_turn_ids": ["a", "b"]}],
                "after_rerank": [{"matched_source_turn_ids": ["a"]}],
            },
            "q2": {
                "required_source_turn_ids": ["c"],
                "available_required_source_turn_ids": [],
                "channels": {},
                "before_rerank": [],
                "after_rerank": [],
            },
        }
        result = evidence_chain(traces, {
            "q1": {"llm_judge_score": 0},
            "q2": {"llm_judge_score": 0.5},
        })
        counts = result["question_counts"]
        self.assertEqual(counts["annotated"], 2)
        self.assertEqual(counts["candidate_full"], 1)
        self.assertEqual(counts["before_rerank_full"], 1)
        self.assertEqual(counts["final_any"], 1)
        self.assertEqual(counts.get("final_full", 0), 0)
        self.assertEqual(counts["final_source_present_but_zero_score"], 1)
        self.assertEqual(counts["final_source_absent_but_positive_score"], 1)
        self.assertEqual(result["mean_source_recall_by_stage"]["final"], 0.25)

    def test_provider_audit_detects_successful_routing_mismatch(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "answers-requests.jsonl"
            records = [
                {"status": "success", "requested_provider": "OpenInference", "provider": "OpenInference"},
                {"status": "error", "requested_provider": "OpenInference"},
                {"status": "success", "requested_provider": "OpenInference", "provider": "Sail Research"},
            ]
            path.write_text("".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")
            result = provider_audit(Path(folder), "answers")
        self.assertEqual(result["successful_requests"], 2)
        self.assertEqual(result["error_attempts"], 1)
        self.assertEqual(result["successful_provider_mismatches"], 1)


if __name__ == "__main__":
    unittest.main()
