"""Summarize a completed AML-local BEAM run without changing its artifacts."""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from statistics import mean
from typing import Any


def rows(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def source_recall(trace: dict[str, Any]) -> float | None:
    required = set(trace.get("required_source_turn_ids") or [])
    if not required:
        return None
    retrieved = set(trace.get("retrieved_source_turn_ids") or [])
    return len(required & retrieved) / len(required)


def summary(directory: Path) -> dict[str, Any]:
    inputs = {row["id"]: row for row in rows(directory / "input.jsonl")}
    traces = {row["question_id"]: row for row in rows(directory / "retrieval-traces.jsonl")}
    answers = {row["id"]: row for row in rows(directory / "answers.jsonl")}
    judged = {row["id"]: row for row in rows(directory / "judged.jsonl")}
    categories: dict[str, dict[str, list[float]]] = defaultdict(lambda: {"score": [], "recall": []})
    recall_by_id: dict[str, float] = {}
    score_by_id: dict[str, float] = {}
    for question_id, record in inputs.items():
        category = str(record.get("category") or "unknown")
        trace = traces.get(question_id)
        if trace:
            recall = source_recall(trace)
            if recall is not None:
                recall_by_id[question_id] = recall
                categories[category]["recall"].append(recall)
        judgement = judged.get(question_id)
        if judgement and isinstance(judgement.get("llm_judge_score"), (int, float)):
            score = float(judgement["llm_judge_score"])
            score_by_id[question_id] = score
            categories[category]["score"].append(score)

    return {
        "directory": str(directory.resolve()),
        "input_questions": len(inputs),
        "retrieval_traces": len(traces),
        "answers": len(answers),
        "judged": len(judged),
        "missing_retrieval_ids": sorted(inputs.keys() - traces.keys()),
        "missing_answer_ids": sorted(inputs.keys() - answers.keys()) if answers else [],
        "missing_judged_ids": sorted(inputs.keys() - judged.keys()) if judged else [],
        "annotated_questions": len(recall_by_id),
        "mean_source_recall_at_12": mean(recall_by_id.values()) if recall_by_id else None,
        "zero_source_recall": sum(value == 0 for value in recall_by_id.values()),
        "full_source_recall": sum(value == 1 for value in recall_by_id.values()),
        "reranker_enabled_traces": sum(
            trace.get("reranker", {}).get("enabled") is True for trace in traces.values()
        ),
        "reasoning_strategies": sorted({
            str(trace.get("reasoning", {}).get("strategy"))
            for trace in traces.values() if isinstance(trace.get("reasoning"), dict)
        }),
        "reasoning_degraded_traces": sum(
            trace.get("reasoning", {}).get("degraded") is True
            for trace in traces.values() if isinstance(trace.get("reasoning"), dict)
        ),
        "final_hits_with_multiple_spans": sum(
            len(hit.get("matched_spans") or []) > 1
            for trace in traces.values() for hit in trace.get("after_rerank", [])
        ),
        "final_hits_with_user_scoped_vector_fallback": sum(
            hit.get("vector_search_fallback") == "user-scoped-exact"
            for trace in traces.values() for hit in trace.get("after_rerank", [])
        ),
        "mean_judge_score": mean(score_by_id.values()) if score_by_id else None,
        "perfect_scores": sum(value == 1 for value in score_by_id.values()),
        "zero_scores": sum(value == 0 for value in score_by_id.values()),
        "partial_scores": sum(0 < value < 1 for value in score_by_id.values()),
        "categories": {
            category: {
                "scored": len(values["score"]),
                "mean_score": mean(values["score"]) if values["score"] else None,
                "annotated": len(values["recall"]),
                "mean_source_recall_at_12": mean(values["recall"]) if values["recall"] else None,
            }
            for category, values in sorted(categories.items())
        },
        "_recall_by_id": recall_by_id,
        "_score_by_id": score_by_id,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, help="path to outputs-<tag>/beam")
    parser.add_argument("--baseline", type=Path, help="optional fixed-code retrieval baseline")
    args = parser.parse_args()
    result = summary(args.run)
    baseline = summary(args.baseline) if args.baseline else None
    if baseline:
        paired = sorted(result["_recall_by_id"].keys() & baseline["_recall_by_id"].keys())
        deltas = [result["_recall_by_id"][question_id] - baseline["_recall_by_id"][question_id] for question_id in paired]
        result["baseline"] = {
            "directory": baseline["directory"],
            "paired_annotated_questions": len(paired),
            "mean_source_recall_delta": mean(deltas) if deltas else None,
            "improved": sum(delta > 0 for delta in deltas),
            "worsened": sum(delta < 0 for delta in deltas),
            "unchanged": sum(delta == 0 for delta in deltas),
        }
    result.pop("_recall_by_id")
    result.pop("_score_by_id")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
