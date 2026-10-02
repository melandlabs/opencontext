"""Summarize a completed AML-local BEAM run without changing its artifacts."""
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
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


def matched_source_ids(hits: list[dict[str, Any]]) -> set[str]:
    return {str(source_id) for hit in hits for source_id in hit.get("matched_source_turn_ids") or []}


def evidence_chain(traces: dict[str, dict[str, Any]], judged: dict[str, dict[str, Any]]) -> dict[str, Any]:
    counts: Counter[str] = Counter()
    recalls: dict[str, list[float]] = defaultdict(list)
    channel_names = ("keyword", "semantic", "hybrid", "entity")
    for question_id, trace in traces.items():
        required = set(trace.get("required_source_turn_ids") or [])
        if not required:
            continue
        counts["annotated"] += 1
        available = set(trace.get("available_required_source_turn_ids") or []) & required
        channel_hits = trace.get("channels") or {}
        channels = {name: matched_source_ids(channel_hits.get(name) or []) & required for name in channel_names}
        candidate = set().union(*channels.values())
        before = matched_source_ids(trace.get("before_rerank") or []) & required
        final = matched_source_ids(trace.get("after_rerank") or []) & required
        stages = {"available": available, "candidate": candidate, "before_rerank": before, "final": final,
                  **{f"{name}_candidate": ids for name, ids in channels.items()}}
        for name, ids in stages.items():
            recalls[name].append(len(ids) / len(required))
            if ids:
                counts[f"{name}_any"] += 1
            if ids == required:
                counts[f"{name}_full"] += 1
        if candidate and not before:
            counts["lost_all_at_fusion"] += 1
        if before and not final:
            counts["lost_all_at_rerank"] += 1
        score = judged.get(question_id, {}).get("llm_judge_score")
        if isinstance(score, (int, float)):
            if final and score == 0:
                counts["final_source_present_but_zero_score"] += 1
            if not final and score > 0:
                counts["final_source_absent_but_positive_score"] += 1
    return {"question_counts": dict(sorted(counts.items())),
            "mean_source_recall_by_stage": {name: mean(values) for name, values in sorted(recalls.items())}}


def provider_audit(directory: Path, stage: str) -> dict[str, Any]:
    requests = rows(directory / f"{stage}-requests.jsonl")
    successes = [row for row in requests if row.get("status") == "success"]
    mismatches = [row for row in successes if row.get("requested_provider") not in (None, "auto")
                  and str(row.get("provider", "")).casefold() != str(row["requested_provider"]).casefold()]
    return {"requests": len(requests), "successful_requests": len(successes),
            "error_attempts": len(requests) - len(successes),
            "success_by_provider": dict(sorted(Counter(str(row.get("provider") or "unknown") for row in successes).items())),
            "success_by_requested_provider": dict(sorted(Counter(str(row.get("requested_provider") or "auto") for row in successes).items())),
            "successful_provider_mismatches": len(mismatches)}


def ranking_ablation(traces: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Compare existing candidate rankings at the same Top-K; no model calls."""
    recalls: dict[str, list[float]] = defaultdict(list)
    names = ("keyword", "semantic", "hybrid", "entity")
    for trace in traces.values():
        required = set(trace.get("required_source_turn_ids") or [])
        if not required:
            continue
        k = int(trace.get("top_k") or 12)
        channels = trace.get("channels") or {}
        rankings = {name: channels.get(name) or [] for name in names}
        rankings.update({"fused_before_rerank": trace.get("before_rerank") or [],
                         "final_after_rerank": trace.get("after_rerank") or []})
        for name, hits in rankings.items():
            recalls[name].append(len(required & matched_source_ids(hits[:k])) / len(required))
    return {name: {"annotated": len(values), "mean_source_recall_at_k": mean(values) if values else None}
            for name, values in sorted(recalls.items())}


def summary(directory: Path) -> dict[str, Any]:
    inputs = {row["id"]: row for row in rows(directory / "input.jsonl")}
    traces = {row["question_id"]: row for row in rows(directory / "retrieval-traces.jsonl")}
    answers = {row["id"]: row for row in rows(directory / "answers.jsonl")}
    judged = {row["id"]: row for row in rows(directory / "judged.jsonl")}
    categories: dict[str, dict[str, list[float]]] = defaultdict(
        lambda: {"score": [], "recall": [], "required_source_count": [], "over_top_k": []}
    )
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
                required_count = len(trace.get("required_source_turn_ids") or [])
                categories[category]["required_source_count"].append(required_count)
                categories[category]["over_top_k"].append(required_count > int(trace.get("top_k") or 12))
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
        "missing_answer_ids": sorted(inputs.keys() - answers.keys()),
        "missing_judged_ids": sorted(inputs.keys() - judged.keys()),
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
                "mean_required_source_turns": mean(values["required_source_count"])
                if values["required_source_count"] else None,
                "questions_requiring_more_than_top_k_sources": sum(values["over_top_k"]),
            }
            for category, values in sorted(categories.items())
        },
        "evidence_chain": evidence_chain(traces, judged),
        "ranking_ablation": ranking_ablation(traces),
        "provider_audit": {stage: provider_audit(directory, stage) for stage in ("answers", "judged")},
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
