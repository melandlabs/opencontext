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
import json
import sys
from pathlib import Path
from typing import Any

SCALES = ["128k", "500k", "1m", "10m"]


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
    return {
        "speaker": str(speaker),
        "text": str(text),
        "timestamp": turn.get("timestamp") or turn.get("ts") or turn.get("time"),
    }


def normalize_question(q: dict[str, Any], idx: int) -> dict[str, Any] | None:
    text = q.get("question") or q.get("query") or q.get("prompt")
    if not text:
        return None
    atoms = q.get("atoms") or q.get("nuggets") or []
    if isinstance(atoms, str):
        atoms = [a.strip() for a in atoms.split("\n") if a.strip()]
    return {
        "question_id": str(q.get("question_id") or q.get("id") or f"q_{idx}"),
        "category": str(q.get("category") or q.get("type") or "information_extraction"),
        "question": str(text),
        "atoms": [str(a) for a in atoms],
        "gold_answer": q.get("gold_answer") or q.get("answer"),
    }


def normalize_conversation(conv: dict[str, Any], idx: int, scale: str) -> dict[str, Any] | None:
    chat = conv.get("chat") or conv.get("turns") or conv.get("messages") or []
    if not chat:
        return None
    questions = (
        conv.get("probing_questions")
        or conv.get("questions")
        or conv.get("evaluation_questions")
        or []
    )
    normalized_questions = []
    for i, q in enumerate(questions):
        nq = normalize_question(q, i)
        if nq is not None:
            normalized_questions.append(nq)
    if not normalized_questions:
        return None
    return {
        "entry_id": str(conv.get("entry_id") or conv.get("id") or conv.get("conversation_id") or f"conv_{idx}"),
        "scale": scale,
        "chat": [normalize_turn(t) for t in chat],
        "probing_questions": normalized_questions,
    }


def convert_hf_split(scale: str, out_path: Path, max_conversations: int | None) -> int:
    """Download the BEAM parquet for `scale` from HF, normalize, write JSON."""
    try:
        from datasets import load_dataset  # type: ignore
    except ImportError:
        print("ERROR: `datasets` not installed. Run: pip install datasets pyarrow", file=sys.stderr)
        sys.exit(1)

    print(f"Loading BEAM/{scale} from HuggingFace…")
    ds = load_dataset("Mohammadta/BEAM", scale, split="train")
    print(f"  → {len(ds)} raw rows")

    out: list[dict[str, Any]] = []
    for i, row in enumerate(ds):
        conv = normalize_conversation(row, i, scale)
        if conv is not None:
            out.append(conv)
        if max_conversations is not None and len(out) >= max_conversations:
            break
        if (i + 1) % 50 == 0:
            print(f"  processed {i + 1} rows, kept {len(out)}…")

    payload = {"scale": scale, "conversations": out}
    out_path.write_text(json.dumps(payload, ensure_ascii=False))
    print(f"✅ Wrote {len(out)} conversations → {out_path} ({out_path.stat().st_size / 1_000_000:.1f} MB)")
    return len(out)


def write_sample(out_path: Path) -> int:
    """Write the bundled sample_conversation.json. No HF download needed."""
    sample = {
        "scale": "sample",
        "conversations": [
            {
                "entry_id": "sample_001",
                "scale": "sample",
                "chat": [
                    {"speaker": "user", "text": "Hey, I just moved to Berlin last week.", "timestamp": "2024-05-01T10:00:00Z"},
                    {"speaker": "assistant", "text": "Welcome! How are you finding it so far?", "timestamp": "2024-05-01T10:00:05Z"},
                    {"speaker": "user", "text": "Pretty good. I started a new job at a fintech on Tuesday.", "timestamp": "2024-05-01T10:01:00Z"},
                    {"speaker": "assistant", "text": "Nice — what kind of role?", "timestamp": "2024-05-01T10:01:10Z"},
                    {"speaker": "user", "text": "I'm a backend engineer, mostly Go and Postgres.", "timestamp": "2024-05-01T10:01:30Z"},
                    {"speaker": "assistant", "text": "Cool. Anything fun planned for the weekend?", "timestamp": "2024-05-01T10:02:00Z"},
                    {"speaker": "user", "text": "I think I'm going to check out the flea market at Mauerpark on Saturday.", "timestamp": "2024-05-04T09:00:00Z"},
                    {"speaker": "assistant", "text": "Mauerpark on a Saturday is iconic — you'll love it.", "timestamp": "2024-05-04T09:00:30Z"},
                ],
                "probing_questions": [
                    {
                        "question_id": "sample_001_q1",
                        "category": "information_extraction",
                        "question": "What city did the user recently move to?",
                        "atoms": ["Berlin"],
                        "gold_answer": "Berlin",
                    }
                ],
            }
        ],
    }
    out_path.write_text(json.dumps(sample, indent=2, ensure_ascii=False))
    print(f"✅ Wrote sample → {out_path}")
    return 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert BEAM parquet → JSON")
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