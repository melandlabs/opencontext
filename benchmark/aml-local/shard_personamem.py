"""Split remaining (unanswered) personamem questions into N shard input files.

Reads outputs/personamem/input.jsonl, drops ids already present in
outputs/personamem/answers.jsonl, and writes the remainder round-robin into
outputs/personamem/shards/input_shard{i}.jsonl.
"""
import json
from pathlib import Path

N_SHARDS = 6
OUT = Path(__file__).parent / "outputs" / "personamem"
inp = [json.loads(l) for l in (OUT / "input.jsonl").open(encoding="utf-8") if l.strip()]
done = {json.loads(l)["id"] for l in (OUT / "answers.jsonl").open(encoding="utf-8") if l.strip()}
remaining = [r for r in inp if r["id"] not in done]
print(f"input={len(inp)} done={len(done)} remaining={len(remaining)}")

shard_dir = OUT / "shards"
shard_dir.mkdir(exist_ok=True)
counts = [0] * N_SHARDS
for i, rec in enumerate(remaining):
    s = i % N_SHARDS
    with (shard_dir / f"input_shard{s}.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    counts[s] += 1
print("shards:", counts)
