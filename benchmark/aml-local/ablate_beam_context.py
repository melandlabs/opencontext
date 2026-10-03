"""Freeze a label-independent BEAM subset for a context-presentation ablation.

This changes only the display of retrieved historical excerpts. Questions,
rubrics, retrieval order, and excerpt text remain unchanged. Run the resulting
input through the normal official-prompt answer/evaluate pipeline.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path

from analyze_beam_run import rows


ORIGINAL_MARKER = "[Original excerpt]\n"
QUOTED_MARKER = "[Quoted historical excerpt]\n"
END_MARKER = "\n[End quoted historical excerpt]"


def quote_context(context: str) -> str:
    prefix, marker, excerpt = context.partition(ORIGINAL_MARKER)
    if not marker:
        raise ValueError("Expected a core-rendered original excerpt")
    quoted = json.dumps(excerpt, ensure_ascii=False)
    # Check lossless quoting, including embedded code, markers, and newlines.
    if json.loads(quoted) != excerpt:
        raise AssertionError("Historical excerpt changed while quoting")
    return prefix + QUOTED_MARKER + quoted + END_MARKER


def select_subset(records: list[dict], per_category: int) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        groups[str(record.get("category", "unknown"))].append(record)
    selected = {
        record["id"]
        for group in groups.values()
        for record in sorted(
            group, key=lambda item: hashlib.sha256(str(item["id"]).encode()).hexdigest()
        )[:per_category]
    }
    return [record for record in records if record["id"] in selected]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--per-category", type=int, default=2)
    args = parser.parse_args()
    if args.per_category < 1:
        parser.error("--per-category must be positive")
    if args.output.exists():
        parser.error("Refusing to overwrite an existing ablation input")
    records = select_subset(rows(args.input), args.per_category)
    transformed = []
    for record in records:
        context = record.get("retrieved_context")
        if not isinstance(context, list) or not all(isinstance(item, str) for item in context):
            raise ValueError(f"Expected retrieved_context strings for {record['id']}")
        transformed.append({**record, "retrieved_context": [quote_context(item) for item in context]})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in transformed),
        encoding="utf-8",
    )
    manifest = {
        "input": str(args.input.resolve()),
        "input_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
        "output_sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
        "selection": "lowest SHA256(question ID), independently within each category",
        "per_category": args.per_category,
        "question_ids": [record["id"] for record in records],
        "intervention": "lossless JSON quoting of historical excerpts; fixed retrieval",
        "official_prompts_changed": False,
    }
    args.output.with_suffix(".manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Prepared {len(records)} fixed-retrieval questions at {args.output}")


if __name__ == "__main__":
    main()
