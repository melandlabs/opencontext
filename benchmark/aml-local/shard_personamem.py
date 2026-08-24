"""Split remaining (unanswered) personamem questions into N shard input files.

Usage: python shard_personamem.py [out_dir]   (default: outputs/personamem)

Reads <out_dir>/input.jsonl, drops ids already present in
<out_dir>/answers.jsonl (if any), and writes the remainder round-robin into
<out_dir>/shards/input_shard{i}.jsonl.
"""
import json
import sys
from pathlib import Path

N_SHARDS = 6
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "outputs" / "personamem"
inp = [json.loads(l) for l in (OUT / "input.jsonl").open(encoding="utf-8") if l.strip()]
answers = OUT / "answers.jsonl"
done = {json.loads(l)["id"] for l in answers.open(encoding="utf-8") if l.strip()} if answers.exists() else set()
remaining = [r for r in inp if r["id"] not in done]
print(f"input={len(inp)} done={len(done)} remaining={len(remaining)}")

shard_dir = OUT / "shards"
shard_dir.mkdir(exist_ok=True)
# start from empty shard files so re-runs don't duplicate
for s in range(N_SHARDS):
    (shard_dir / f"input_shard{s}.jsonl").unlink(missing_ok=True)
counts = [0] * N_SHARDS
for i, rec in enumerate(remaining):
    s = i % N_SHARDS
    with (shard_dir / f"input_shard{s}.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    counts[s] += 1
print("shards:", counts)
