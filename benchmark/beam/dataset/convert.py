#!/usr/bin/env python3
"""
Convert BEAM parquet files from HuggingFace to one JSON file per scale.

BEAM (Tavakoli et al., ICLR 2026) is distributed as parquet on
HuggingFace: https://huggingface.co/datasets/Mohammadta/BEAM

There are 4 scale buckets: 128k / 500k / 1m / 10m. Each parquet contains a
list of conversations with `chat` (turns) and `probing_questions` (with
`category`, `question`, `atoms`).

Usage:
    # Convert all 4 scales (heavy — needs ~20GB disk + HF auth)
    pip install pyarrow datasets
    python dataset/convert.py --scale 1m

    # Convert just the sample (offline, no HF download)
    python dataset/convert.py --scale sample
"""

from __future__ import annotations

import argparse
import ast
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any

CONVERTER_SCHEMA_VERSION = "2"

BEAM_SOURCES: dict[str, dict[str, str]] = {
    "128k": {
        "repository": "Mohammadta/BEAM",
        "config": "default",
        "split": "100K",
        "revision": "3205395e897e7318c7b094ef4e6047b9b82dbb03",
    },
    "500k": {
        "repository": "Mohammadta/BEAM",
        "config": "default",
        "split": "500K",
        "revision": "3205395e897e7318c7b094ef4e6047b9b82dbb03",
    },
    "1m": {
        "repository": "Mohammadta/BEAM",
        "config": "default",
        "split": "1M",
        "revision": "3205395e897e7318c7b094ef4e6047b9b82dbb03",
    },
    "10m": {
        "repository": "Mohammadta/BEAM-10M",
        "config": "default",
        "split": "10M",
        "revision": "9b2096193fe74e2837e4713e483351e19817773c",
    },
}

SCALES = list(BEAM_SOURCES)


def collect_preflight_errors(
    scale: str,
    out_dir: Path,
    max_conversations: int | None,
) -> list[str]:
    """Check local requirements before creating files or loading Hugging Face data."""
    errors: list[str] = []
    if max_conversations is not None and max_conversations < 1:
        errors.append("--max-conversations must be a positive integer")

    candidate = out_dir.resolve()
    while not candidate.exists() and candidate.parent != candidate:
        candidate = candidate.parent
    if not candidate.is_dir() or not os.access(candidate, os.W_OK):
        errors.append(f"output directory is not writable: {out_dir.resolve()}")

    if scale != "sample":
        for dependency in ("datasets", "pyarrow"):
            if importlib.util.find_spec(dependency) is None:
                errors.append(
                    f"Python dependency missing for non-sample conversion: {dependency}"
                )
    return errors


def get_beam_source(scale: str) -> dict[str, str]:
    """Return the upstream Hugging Face source for a local BEAM scale."""
    try:
        return BEAM_SOURCES[scale]
    except KeyError as error:
        supported = ", ".join(SCALES)
        raise ValueError(f"Unknown BEAM scale '{scale}'. Expected one of: {supported}") from error


def normalize_turn(turn: dict[str, Any]) -> dict[str, Any]:
    """Map BEAM turn dict → {speaker, text, timestamp}.

    BEAM uses a variety of field names across the 4 buckets. We try the
    most common ones and fall back gracefully.
    """
    speaker = (
        turn.get("speaker")
        or turn.get("role")
        or turn.get("from")
        or turn.get("name")
        or "user"
    )
    text = (
        turn.get("text")
        or turn.get("content")
        or turn.get("message")
        or turn.get("value")
        or ""
    )
    source_id = turn.get("id")
    source_index = turn.get("index")
    return {
        "speaker": str(speaker),
        "text": str(text),
        "timestamp": (
            turn.get("timestamp")
            or turn.get("ts")
            or turn.get("time")
            or turn.get("time_anchor")
        ),
        "source_id": str(source_id) if source_id is not None else None,
        "source_index": str(source_index) if source_index is not None else None,
    }


def flatten_scalar_values(value: Any) -> list[str]:
    """Flatten list/dict/scalar provenance fields without inventing ids."""
    if value is None:
        return []
    if isinstance(value, dict):
        flattened: list[str] = []
        for nested in value.values():
            flattened.extend(flatten_scalar_values(nested))
        return flattened
    if isinstance(value, (list, tuple, set)):
        flattened = []
        for nested in value:
            flattened.extend(flatten_scalar_values(nested))
        return flattened
    return [str(value)]


def normalize_source_chat_ids(value: Any) -> list[str]:
    """Drop published placeholder cells while preserving real upstream ids."""
    placeholders = {"", "--", "none", "null", "n/a"}
    return [item for item in flatten_scalar_values(value) if item.strip().lower() not in placeholders]


def normalize_question(q: dict[str, Any], idx: int) -> dict[str, Any] | None:
    text = q.get("question") or q.get("query") or q.get("prompt")
    if not text:
        return None
    atoms = q.get("atoms") or q.get("nuggets") or q.get("rubric") or []
    if isinstance(atoms, str):
        atoms = [a.strip() for a in atoms.split("\n") if a.strip()]
    return {
        "question_id": str(q.get("question_id") or q.get("id") or f"q_{idx}"),
        "category": str(q.get("category") or q.get("type") or "information_extraction"),
        "question": str(text),
        "atoms": [str(a) for a in atoms],
        "gold_answer": (
            q.get("gold_answer")
            or q.get("answer")
            or q.get("ideal_answer")
            or q.get("ideal_response")
            or q.get("ideal_summary")
            or q.get("expected_compliance")
        ),
        "source": {
            "source_chat_ids": normalize_source_chat_ids(q.get("source_chat_ids")),
            "conversation_references": flatten_scalar_values(
                q.get("conversation_references") or q.get("conversation_reference")
            ),
            "plan_references": flatten_scalar_values(
                q.get("plan_references") or q.get("plan_reference")
            ),
            "why_unanswerable": q.get("why_unanswerable"),
        },
    }


def flatten_chat_turns(chat: Any) -> list[dict[str, Any]]:
    """Flatten the published chat layouts into an ordered turn list."""
    turns: list[dict[str, Any]] = []

    def visit(item: Any) -> None:
        if isinstance(item, list):
            for child in item:
                visit(child)
            return
        if not isinstance(item, dict):
            return
        if any(key in item for key in ("text", "content", "message", "value")):
            turns.append(item)
            return
        if "turns" in item:
            visit(item["turns"])
            return
        for child in item.values():
            if isinstance(child, (dict, list)):
                visit(child)

    visit(chat)
    return turns


def normalize_conversation(conv: dict[str, Any], idx: int, scale: str) -> dict[str, Any] | None:
    chat = conv.get("chat") or conv.get("turns") or conv.get("messages") or []
    if not chat:
        return None
    raw_questions = (
        conv.get("probing_questions")
        or conv.get("questions")
        or conv.get("evaluation_questions")
        or []
    )

    if isinstance(raw_questions, str):
        try:
            raw_questions = ast.literal_eval(raw_questions)
        except (SyntaxError, ValueError) as error:
            raise ValueError("probing_questions is not a valid serialized literal") from error

    questions: list[dict[str, Any]] = []
    if isinstance(raw_questions, dict):
        for category, category_questions in raw_questions.items():
            if not isinstance(category_questions, list):
                raise ValueError(f"probing_questions category '{category}' is not a list")
            for question in category_questions:
                if not isinstance(question, dict):
                    raise ValueError(f"probing_questions category '{category}' contains a non-object")
                questions.append({**question, "category": question.get("category") or str(category)})
    elif isinstance(raw_questions, list):
        if not all(isinstance(question, dict) for question in raw_questions):
            raise ValueError("probing_questions contains a non-object")
        questions = raw_questions
    else:
        raise ValueError("probing_questions must be a list, mapping, or serialized mapping")

    turns = flatten_chat_turns(chat)
    if not turns:
        raise ValueError("chat does not contain any recognizable turns")

    entry_id = str(
        conv.get("entry_id")
        or conv.get("id")
        or conv.get("conversation_id")
        or f"conv_{idx}"
    )
    normalized_questions = []
    for i, q in enumerate(questions):
        nq = normalize_question(q, i)
        if nq is not None:
            if not (q.get("question_id") or q.get("id")):
                nq["question_id"] = f"{scale}_{entry_id}_q_{i}"
            normalized_questions.append(nq)
    if not normalized_questions:
        return None
    return {
        "entry_id": entry_id,
        "scale": scale,
        "chat": [normalize_turn(turn) for turn in turns],
        "probing_questions": normalized_questions,
    }


def convert_hf_split(
    scale: str,
    out_path: Path,
    max_conversations: int | None,
    load_dataset_fn: Any | None = None,
) -> int:
    """Download the BEAM parquet for `scale` from HF, normalize, write JSON."""
    source = get_beam_source(scale)
    if load_dataset_fn is None:
        try:
            from datasets import load_dataset  # type: ignore
        except ImportError:
            print("ERROR: `datasets` not installed. Run: pip install datasets pyarrow", file=sys.stderr)
            sys.exit(1)
        load_dataset_fn = load_dataset

    print(
        "Loading "
        f"{source['repository']} config={source['config']} split={source['split']} "
        f"for local scale {scale} from HuggingFace..."
    )
    ds = load_dataset_fn(
        source["repository"],
        source["config"],
        split=source["split"],
        revision=source["revision"],
    )
    print(f"  -> {len(ds)} raw rows")

    # Write one normalized conversation at a time. The 10M split is several
    # hundred MB compressed and can exhaust memory if converted into one large
    # Python list before serialization.
    temp_path = out_path.with_suffix(f"{out_path.suffix}.tmp")
    kept = 0
    try:
        with temp_path.open("w", encoding="utf-8") as output:
            header = {
                "scale": scale,
                "source": {
                    **source,
                    "converter_schema_version": CONVERTER_SCHEMA_VERSION,
                },
            }
            output.write(json.dumps(header, ensure_ascii=False)[:-1])
            output.write(', "conversations": [')
            for i, row in enumerate(ds):
                conv = normalize_conversation(row, i, scale)
                if conv is not None:
                    if kept > 0:
                        output.write(",")
                    output.write(json.dumps(conv, ensure_ascii=False))
                    kept += 1
                if max_conversations is not None and kept >= max_conversations:
                    break
                if (i + 1) % 50 == 0:
                    print(f"  processed {i + 1} rows, kept {kept}...")
            output.write("]}")
        temp_path.replace(out_path)
    finally:
        temp_path.unlink(missing_ok=True)

    print(f"[ok] Wrote {kept} conversations -> {out_path} ({out_path.stat().st_size / 1_000_000:.1f} MB)")
    return kept


def write_sample(out_path: Path) -> int:
    """Write the bundled sample_conversation.json. No HF download needed."""
    sample = {
        "scale": "sample",
        "conversations": [
            {
                "entry_id": "sample_001",
                "scale": "sample",
                "chat": [
                    {"speaker": "user", "text": "Hey, I just moved to Berlin last week.", "timestamp": "2024-05-01T10:00:00Z", "source_id": "0"},
                    {"speaker": "assistant", "text": "Welcome! How are you finding it so far?", "timestamp": "2024-05-01T10:00:05Z", "source_id": "1"},
                    {"speaker": "user", "text": "Pretty good. I started a new job at a fintech on Tuesday.", "timestamp": "2024-05-01T10:01:00Z", "source_id": "2"},
                    {"speaker": "assistant", "text": "Nice — what kind of role?", "timestamp": "2024-05-01T10:01:10Z", "source_id": "3"},
                    {"speaker": "user", "text": "I'm a backend engineer, mostly Go and Postgres.", "timestamp": "2024-05-01T10:01:30Z", "source_id": "4"},
                    {"speaker": "assistant", "text": "Cool. Anything fun planned for the weekend?", "timestamp": "2024-05-01T10:02:00Z", "source_id": "5"},
                    {"speaker": "user", "text": "I think I'm going to check out the flea market at Mauerpark on Saturday.", "timestamp": "2024-05-04T09:00:00Z", "source_id": "6"},
                    {"speaker": "assistant", "text": "Mauerpark on a Saturday is iconic — you'll love it.", "timestamp": "2024-05-04T09:00:30Z", "source_id": "7"},
                ],
                "probing_questions": [
                    {
                        "question_id": "sample_001_q1",
                        "category": "information_extraction",
                        "question": "What city did the user recently move to?",
                        "atoms": ["Berlin"],
                        "gold_answer": "Berlin",
                        "source": {
                            "source_chat_ids": ["0"],
                            "conversation_references": ["chat_id: 0"],
                            "plan_references": [],
                        },
                    }
                ],
            }
        ],
    }
    out_path.write_text(json.dumps(sample, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[ok] Wrote sample -> {out_path}")
    return 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert BEAM parquet to JSON")
    parser.add_argument(
        "--scale",
        choices=SCALES + ["sample", "all"],
        default="1m",
        help="Which scale to convert. 'sample' skips HF and writes the bundled sample.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Where to write the JSON file (default: same dir as this script).",
    )
    parser.add_argument(
        "--max-conversations",
        type=int,
        default=None,
        help="Cap on conversations to convert (useful for smoke tests).",
    )
    args = parser.parse_args()

    errors = collect_preflight_errors(args.scale, args.out_dir, args.max_conversations)
    if errors:
        print("BEAM conversion preflight failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        raise SystemExit(2)

    args.out_dir.mkdir(parents=True, exist_ok=True)

    scales = SCALES if args.scale == "all" else [args.scale]
    for scale in scales:
        if scale == "sample":
            out_path = args.out_dir / "sample_conversation.json"
            write_sample(out_path)
        else:
            out_path = args.out_dir / f"beam_{scale}.json"
            convert_hf_split(scale, out_path, args.max_conversations)


if __name__ == "__main__":
    main()
