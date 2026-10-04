"""Build diagnostic source mappings with the unchanged AML ingestion adapter.

Source annotations are used only by trace analysis, never retrieval or models.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from retrieve import beam_source_ids, read_json, read_jsonl, write_jsonl


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--traces", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    required = {str(row["entry_id"]): row["user_id"] for row in read_jsonl(args.traces)}
    entries = read_json(args.dataset)
    if isinstance(entries, dict):
        entries = entries.get("conversations", [])
    mapped = []
    for entry in entries:
        ident = str(entry["entry_id"])
        if ident in required:
            sources = beam_source_ids(entry, args.dataset)
            if any(not message_id.startswith(f"aml:{required[ident]}:") for message_id in sources):
                raise ValueError("Dataset scope differs from the frozen retrieval trace")
            mapped.append({"entry_id": ident, "user_id": required[ident], "source_ids": sources})
    if {row["entry_id"] for row in mapped} != set(required):
        raise ValueError("Some trace entries are absent from the dataset")
    write_jsonl(args.output, mapped)
    print(f"[source-map] {len(mapped)} entries, {sum(len(row['source_ids']) for row in mapped)} original messages")


if __name__ == "__main__":
    main()
