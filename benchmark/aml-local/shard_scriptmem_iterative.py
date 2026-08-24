"""Split scriptmem-iterative input into N shards for parallel answering,
and merge shard answers back into answers.jsonl.

Usage:
  python shard_scriptmem_iterative.py split [dir]  # input.jsonl -> shards/input_shard{i}.jsonl
  python shard_scriptmem_iterative.py merge [dir]  # shards/answers_shard{i}.jsonl -> answers.jsonl
  dir defaults to scriptmem-iterative (e.g. scriptmem-union).
"""
import json
import sys
from pathlib import Path

N_SHARDS = 8
DIR_NAME = sys.argv[2] if len(sys.argv) > 2 else "scriptmem-iterative"
OUT = Path(__file__).parent / "outputs" / DIR_NAME
SHARD_DIR = OUT / "shards"


def split() -> None:
    inp = [json.loads(l) for l in (OUT / "input.jsonl").open(encoding="utf-8") if l.strip()]
    answers = OUT / "answers.jsonl"
    done = set()
    if answers.exists():
        done = {json.loads(l)["id"] for l in answers.open(encoding="utf-8") if l.strip()}
    remaining = [r for r in inp if r["id"] not in done]
    print(f"input={len(inp)} done={len(done)} remaining={len(remaining)}")

    SHARD_DIR.mkdir(exist_ok=True)
    # truncate shard inputs so re-splits are idempotent
    handles = [(SHARD_DIR / f"input_shard{s}.jsonl").open("w", encoding="utf-8") for s in range(N_SHARDS)]
    counts = [0] * N_SHARDS
    for i, rec in enumerate(remaining):
        s = i % N_SHARDS
        handles[s].write(json.dumps(rec, ensure_ascii=False) + "\n")
        counts[s] += 1
    for h in handles:
        h.close()
    print("shards:", counts)


def merge() -> None:
    seen = {}
    for s in range(N_SHARDS):
        shard_answers = SHARD_DIR / f"answers_shard{s}.jsonl"
        if not shard_answers.exists():
            print(f"missing {shard_answers}")
            continue
        for line in shard_answers.open(encoding="utf-8"):
            if line.strip():
                row = json.loads(line)
                seen[str(row["id"])] = row
    total_input = sum(1 for l in (OUT / "input.jsonl").open(encoding="utf-8") if l.strip())
    with (OUT / "answers.jsonl").open("w", encoding="utf-8") as f:
        for row in seen.values():
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"merged {len(seen)} answers (input has {total_input})")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("split", "merge"):
        raise SystemExit(__doc__)
    if sys.argv[1] == "split":
        split()
    else:
        merge()
