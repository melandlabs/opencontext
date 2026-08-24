"""Build a union input.jsonl for ScriptMem: iterative-recall evidence sessions
first, then baseline top-k sessions (dedup by session header), capped at
MAX_SESSIONS sessions so the context budget matches the baseline run.

Reads:
  outputs/scriptmem/input.jsonl            (baseline daemon top-10)
  outputs/scriptmem-iterative/input.jsonl  (iterative evidence-only, ~5)
Writes:
  outputs/scriptmem-union/input.jsonl
"""
import json
import re
from pathlib import Path

OUT = Path(__file__).parent / "outputs"
MAX_SESSIONS = 10

# A hit starts with "# <title> — <key>\n# Date: ..."; hits are joined by "\n\n".
SESSION_RE = re.compile(r"(?m)^# (?P<title>[^\n]+?) — (?P<key>[^\n]+)\n# Date: ")


def split_sessions(memories: str) -> list[tuple[str, str]]:
    """Return [(session_key, full_text)] preserving order."""
    matches = list(SESSION_RE.finditer(memories))
    sessions = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(memories)
        text = memories[m.start():end].strip("\n")
        sessions.append((f"{m.group('title')} — {m.group('key')}", text))
    return sessions


def main() -> None:
    base = {json.loads(l)["id"]: json.loads(l) for l in (OUT / "scriptmem" / "input.jsonl").open(encoding="utf-8") if l.strip()}
    it = {json.loads(l)["id"]: json.loads(l) for l in (OUT / "scriptmem-iterative" / "input.jsonl").open(encoding="utf-8") if l.strip()}
    assert set(base) == set(it), "id mismatch between baseline and iterative inputs"

    out_dir = OUT / "scriptmem-union"
    out_dir.mkdir(exist_ok=True)
    unparsed = 0
    counts = []
    with (out_dir / "input.jsonl").open("w", encoding="utf-8") as f:
        for rid, rec in it.items():
            ev_sessions = split_sessions(rec["speaker_1_memories"])
            base_sessions = split_sessions(base[rid]["speaker_1_memories"])
            if not ev_sessions or not base_sessions:
                unparsed += 1
            seen = set()
            merged = []
            for key, text in ev_sessions + base_sessions:
                if key in seen:
                    continue
                seen.add(key)
                merged.append(text)
                if len(merged) >= MAX_SESSIONS:
                    break
            counts.append(len(merged))
            row = dict(rec)
            row["speaker_1_memories"] = "\n\n".join(merged)
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"wrote {len(counts)} records -> {out_dir / 'input.jsonl'}")
    print(f"sessions/record: min={min(counts)} max={max(counts)} mean={sum(counts)/len(counts):.1f}")
    if unparsed:
        print(f"WARNING: {unparsed} records had unparseable session headers")


if __name__ == "__main__":
    main()
