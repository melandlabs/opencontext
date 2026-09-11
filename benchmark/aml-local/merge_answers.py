"""Merge sharded AML answer JSONL files with strict coverage validation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--answers-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    expected = [str(row["id"]) for row in read_jsonl(args.input)]
    if len(expected) != len(set(expected)):
        raise SystemExit("input contains duplicate ids")

    rows_by_id: dict[str, dict] = {}
    for path in sorted(args.answers_dir.glob("answers*.jsonl")):
        if path.resolve() == args.output.resolve():
            continue
        for row in read_jsonl(path):
            row_id = str(row["id"])
            if row_id in rows_by_id:
                raise SystemExit(f"duplicate answer id: {row_id}")
            rows_by_id[row_id] = row

    missing = [row_id for row_id in expected if row_id not in rows_by_id]
    unexpected = sorted(set(rows_by_id) - set(expected))
    if missing or unexpected:
        raise SystemExit(f"answer coverage mismatch: missing={len(missing)} unexpected={len(unexpected)}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "".join(json.dumps(rows_by_id[row_id], ensure_ascii=False) + "\n" for row_id in expected),
        encoding="utf-8",
    )
    print(f"merged {len(expected)} answers -> {args.output}")


if __name__ == "__main__":
    main()
