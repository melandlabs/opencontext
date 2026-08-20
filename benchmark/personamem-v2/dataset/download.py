#!/usr/bin/env python3
"""
Download the PersonaMem-v2 benchmark from HuggingFace.

PersonaMem-v2 (Jiang et al., arXiv:2512.06688) is distributed at
https://huggingface.co/datasets/bowen-upenn/PersonaMem-v2 as:
  - benchmark/{text,multimodal}/benchmark.csv   (5,000 benchmark Q&As)
  - data/chat_history_{32k,128k}/...            (per-persona chat histories)
  - data/chat_history_multimodal_{32k,128k}/... (multimodal variants)

This script downloads the benchmark CSV plus the chat-history JSON files
referenced by its `chat_history_32k_link` / `chat_history_128k_link` columns,
using only the Python standard library. Already-downloaded files are skipped,
so re-running resumes where it left off.

Usage:
    # Benchmark CSV + all 32k text histories (~200 MB)
    python dataset/download.py

    # Both context lengths
    python dataset/download.py --context both

    # Smoke test: only histories for the first 5 personas
    python dataset/download.py --max-personas 5

    # Multimodal variant
    python dataset/download.py --variant multimodal
"""

from __future__ import annotations

import argparse
import csv
import sys
import urllib.request
from pathlib import Path

HF_BASE = "https://huggingface.co/datasets/bowen-upenn/PersonaMem-v2/resolve/main"


def download(url: str, dest: Path) -> int:
    """Download url -> dest, skipping if dest already exists. Returns bytes written."""
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  skip (exists): {dest.name}")
        return 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"  downloading: {url}")
    with urllib.request.urlopen(url) as resp, tmp.open("wb") as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    tmp.replace(dest)
    return dest.stat().st_size


def collect_history_links(csv_path: Path, context: str, max_personas: int | None) -> list[str]:
    """Read the benchmark CSV and return the chat-history links to download."""
    link_col = f"chat_history_{context}_link"
    seen_personas: set[str] = set()
    links: list[str] = []
    with csv_path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            persona_id = row["persona_id"]
            if max_personas is not None and persona_id not in seen_personas:
                if len(seen_personas) >= max_personas:
                    continue
            seen_personas.add(persona_id)
            link = row.get(link_col, "").strip()
            if link and link not in links:
                links.append(link)
    return links


def main() -> None:
    parser = argparse.ArgumentParser(description="Download PersonaMem-v2 from HuggingFace")
    parser.add_argument(
        "--variant",
        choices=["text", "multimodal"],
        default="text",
        help="Benchmark variant (default: text).",
    )
    parser.add_argument(
        "--context",
        choices=["32k", "128k", "both"],
        default="32k",
        help="Which chat-history context length(s) to download (default: 32k).",
    )
    parser.add_argument(
        "--max-personas",
        type=int,
        default=None,
        help="Only download histories for the first N personas (smoke test).",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Where to put benchmark.csv and chat-history dirs (default: this dir).",
    )
    args = parser.parse_args()

    csv_dest = args.out_dir / "benchmark.csv"
    print(f"[1/2] Benchmark CSV ({args.variant}) -> {csv_dest}")
    download(f"{HF_BASE}/benchmark/{args.variant}/benchmark.csv", csv_dest)

    contexts = ["32k", "128k"] if args.context == "both" else [args.context]
    print(f"[2/2] Chat histories: {contexts}")
    for ctx in contexts:
        links = collect_history_links(csv_dest, ctx, args.max_personas)
        print(f"  {ctx}: {len(links)} history files")
        total = 0
        for i, link in enumerate(links):
            total += download(f"{HF_BASE}/{link}", args.out_dir / link)
            if (i + 1) % 50 == 0:
                print(f"  … {i + 1}/{len(links)} files ({total / 1_000_000:.0f} MB new)")
        print(f"  {ctx}: done, {total / 1_000_000:.0f} MB downloaded")

    print("✅ Dataset ready:", args.out_dir)


if __name__ == "__main__":
    sys.exit(main())
