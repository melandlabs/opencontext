"""Re-split an arm's input.jsonl into N small answer shards (resume-aware).

Usage: python reshard_answers.py <input.jsonl> <num_shards> [shard_size]

Writes <shard_size>-record files input.ashard{i}.jsonl next to the input,
round-robin by position, skipping ids already present in answers*.jsonl.
"""
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
n_shards = int(sys.argv[2]) if len(sys.argv) > 2 else 10
size = int(sys.argv[3]) if len(sys.argv) > 3 else 500

rows = [json.loads(l) for l in src.open(encoding="utf-8") if l.strip()]
done = set()
for f in src.parent.glob("answers*.jsonl"):
    for l in f.open(encoding="utf-8"):
        if l.strip():
            try:
                done.add(json.loads(l)["id"])
            except Exception:
                pass
rows = [r for r in rows if r["id"] not in done]
files = [(src.parent / f"input.ashard{i}.jsonl").open("w", encoding="utf-8") for i in range(n_shards)]
try:
    for i, r in enumerate(rows):
        files[(i // size) % n_shards].write(json.dumps(r, ensure_ascii=False) + "\n")
finally:
    for f in files:
        f.close()
print(f"{src.parent}: {len(rows)} to answer in {n_shards} shards")
