#!/usr/bin/env python3
"""Download the ScriptMem benchmark data (questions/options/gold answers).

ScriptMem (MemoraX AI / Oxford, CC BY-NC 4.0) is distributed at
https://github.com/memorax-ai/ScriptMem as data/raw/{angry,enemy,friends,man_earth}.json.

Note: the upstream release does NOT include the original script conversation
text (copyright) — the `conversation` field holds only an omission notice plus
a short synthetic schema example. The AML platform holds the private
conversations; locally we can only ingest what upstream publishes.

Already-downloaded files are skipped, so re-running resumes where it left off.

Usage:
    python dataset/download.py
"""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

RAW_BASE = "https://raw.githubusercontent.com/memorax-ai/ScriptMem/main/data/raw"
FILES = ("angry.json", "enemy.json", "friends.json", "man_earth.json")


def download(url: str, dest: Path) -> int:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  skip (exists): {dest.name}")
        return 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"  downloading: {url}")
    expected = None
    with urllib.request.urlopen(url) as resp, tmp.open("wb") as f:
        if resp.headers.get("Content-Length"):
            expected = int(resp.headers["Content-Length"])
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    actual = tmp.stat().st_size
    if expected is not None and actual != expected:
        tmp.unlink()
        raise IOError(f"truncated download: {url} ({actual}/{expected} bytes) — re-run to resume")
    tmp.replace(dest)
    return dest.stat().st_size


def main() -> None:
    out_dir = Path(__file__).resolve().parent / "raw"
    for name in FILES:
        download(f"{RAW_BASE}/{name}", out_dir / name)
    print("Dataset ready:", out_dir)


if __name__ == "__main__":
    sys.exit(main())
