"""Local AML-style retrieval layer for OpenContext.

Plays the role of AML's orchestrator locally:
  dataset -> ingest into the OpenContext memory daemon (POST /v1/raw-messages,
  per-sample userId isolation) -> per-question retrieval (POST /v1/search) ->
  AML-pipeline-compatible input JSONL.

The emitted JSONL feeds the official public pipelines in
benchmark/AML-agent-memory-leaderboard/data/<bench>/pipeline.py (answer/evaluate).

Usage:
  python retrieve.py longmemeval --limit 5
  python retrieve.py locomo --samples conv-26
  python retrieve.py clbench --limit 2
  python retrieve.py beam --limit 1
  python retrieve.py personamem --limit 1 --max-questions 5
  python retrieve.py scriptmem --max-questions 5

Env:
  OPENCONTEXT_URL   default http://127.0.0.1:7421
  AML_TOP_K         default 10
"""
from __future__ import annotations

import argparse
import ast
import csv
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

BENCH_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = Path(__file__).resolve().parent / "outputs"

BASE = os.environ.get("OPENCONTEXT_URL", "http://127.0.0.1:7421").rstrip("/")
TOP_K = int(os.environ.get("AML_TOP_K", "10"))
BATCH = 25


def http_post(path: str, payload: dict, timeout: int = 600) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def health() -> None:
    with urllib.request.urlopen(BASE + "/health", timeout=10) as resp:
        if resp.status != 200:
            raise SystemExit(f"daemon unhealthy: {resp.status}")


def ingest(messages: list[dict], user_id: str) -> int:
    total = 0
    for i in range(0, len(messages), BATCH):
        batch = [{**m, "userId": user_id} for m in messages[i : i + BATCH]]
        res = http_post("/v1/raw-messages", {"userId": user_id, "messages": batch, "embedOnInsert": True})
        total += int(res.get("count", len(batch)))
    return total


def search(query: str, user_id: str, top_k: int = TOP_K) -> list[dict]:
    res = http_post("/v1/search", {"userId": user_id, "query": query, "limit": top_k, "sources": ["memory"]}, timeout=120)
    return res.get("results", [])


def parse_ts(value: str | None) -> int:
    if not value:
        return int(time.time() * 1000)
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return int(time.time() * 1000)


def iso_from_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def now_ms() -> int:
    return int(time.time() * 1000)


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"[aml-local] wrote {len(records)} records -> {path}")


# ---------------------------------------------------------------- longmemeval

def run_longmemeval(args) -> None:
    data = json.loads((BENCH_ROOT / "longmemeval/dataset/longmemeval_s_cleaned.json").read_text(encoding="utf-8"))
    if args.samples:
        wanted = set(args.samples.split(","))
        data = [e for e in data if e["question_id"] in wanted]
    if args.limit:
        data = data[: args.limit]
    records = []
    for entry in data:
        qid = entry["question_id"]
        user_id = f"aml_lme_{qid}"
        if not args.skip_ingest:
            msgs = []
            sessions = entry.get("haystack_sessions", [])
            sids = entry.get("haystack_session_ids", [])
            dates = entry.get("haystack_dates", [])
            for i, session in enumerate(sessions):
                sid = sids[i] if i < len(sids) else f"session_{i}"
                date = dates[i] if i < len(dates) else ""
                body = "\n".join(
                    f"{'User' if t.get('role') == 'user' else 'Assistant'}: {t.get('content', '')}" for t in session
                )
                content = f"# Conversation Session {sid}\n# Date: {date}\n\n{body}"
                ts = parse_ts(date)
                msgs.append({
                    "messageId": f"{user_id}__{sid}",
                    "platform": "benchmark", "botId": "aml-longmemeval",
                    "timestamp": ts, "content": content, "createdAt": now_ms(),
                })
            n = ingest(msgs, user_id)
            print(f"[longmemeval] ingested {n} sessions for {qid}")
        hits = search(entry["question"], user_id)
        records.append({
            "id": qid,
            "question": entry["question"],
            "question_type": entry.get("question_type"),
            "retrieved_context": [h.get("content", "") for h in hits],
            "gold_answer": entry.get("answer", ""),
        })
    write_jsonl(OUT_DIR / "longmemeval-s" / "input.jsonl", records)


# ---------------------------------------------------------------- locomo

def run_locomo(args) -> None:
    data = json.loads((BENCH_ROOT / "locomo/dataset/locomo_v2.json").read_text(encoding="utf-8"))
    if args.samples:
        wanted = set(args.samples.split(","))
        data = [s for s in data if s.get("sample_id") in wanted]
    if args.limit:
        data = data[: args.limit]
    records = []
    for sample in data:
        sid = sample["sample_id"]
        user_id = f"aml_locomo_{sid}"
        conv = sample.get("conversation", {})
        if not args.skip_ingest:
            msgs = []
            n_sessions = 0
            for key in sorted(conv.keys()):
                if not key.startswith("session_") or key.endswith("_date_time"):
                    continue
                num = key.split("_")[1]
                turns = conv.get(key) or []
                if not isinstance(turns, list) or not turns:
                    continue
                date = conv.get(f"session_{num}_date_time", "")
                body = "\n".join(f"{t.get('speaker', '?')}: {t.get('text', '')}" for t in turns)
                content = f"# Conversation Session {num}\n# Date: {date}\n\n{body}"
                msgs.append({
                    "messageId": f"{user_id}__session_{num}",
                    "platform": "benchmark", "botId": "aml-locomo",
                    "timestamp": parse_ts(date), "content": content, "createdAt": now_ms(),
                })
                n_sessions += 1
            n = ingest(msgs, user_id)
            print(f"[locomo] ingested {n} sessions for {sid}")
        for i, qa in enumerate(sample.get("qa", [])):
            if args.max_questions and i >= args.max_questions:
                break
            answer = qa.get("answer")
            if answer is None or (isinstance(answer, str) and not answer.strip()):
                continue
            hits = search(qa["question"], user_id)
            records.append({
                "id": f"{sid}__q{i}",
                "question": qa["question"],
                "category": qa.get("category"),
                "retrieved_context": [h.get("content", "") for h in hits],
                "gold_answer": str(answer),
            })
    write_jsonl(OUT_DIR / "locomo-refined" / "input.jsonl", records)


# ---------------------------------------------------------------- clbench

def run_clbench(args) -> None:
    rows = []
    with (BENCH_ROOT / "clbench-official/CL-bench-Life.jsonl").open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    if args.limit:
        rows = rows[: args.limit]
    records = []
    for idx, row in enumerate(rows):
        meta = row.get("metadata", {})
        task_id = str(meta.get("task_id") or f"cl_{idx}")
        user_id = f"aml_clbench_{task_id}"
        messages = row.get("messages", [])
        context_msgs = messages[:-1]
        question_msg = messages[-1] if messages else {}
        question = question_msg.get("content", "")
        if not args.skip_ingest:
            msgs = []
            for i, m in enumerate(context_msgs):
                role = str(m.get("role", "user")).capitalize()
                msgs.append({
                    "messageId": f"{user_id}_m{i}",
                    "platform": "benchmark", "botId": "aml-clbench",
                    "timestamp": now_ms(), "content": f"{role}: {m.get('content', '')}", "createdAt": now_ms(),
                })
            if msgs:
                n = ingest(msgs, user_id)
                print(f"[clbench] ingested {n} context messages for {task_id}")
        hits = search(question[:2000], user_id)
        records.append({
            "id": task_id,
            "question": question,
            "system_prompt": "",
            "retrieval": {"selected": [
                {"text": h.get("content", ""), "created_at": iso_from_ms(int(h.get("metadata", {}).get("timestamp", 0) or now_ms()))}
                for h in hits
            ]},
            "rubrics": row.get("rubrics", []),
            "metadata": meta,
        })
    write_jsonl(OUT_DIR / "clbench" / "input.jsonl", records)


# ---------------------------------------------------------------- beam

def run_beam(args) -> None:
    dataset_path = BENCH_ROOT / "beam/dataset" / args.dataset
    data = json.loads(dataset_path.read_text(encoding="utf-8"))
    conversations = data["conversations"] if isinstance(data, dict) else data
    if args.limit:
        conversations = conversations[: args.limit]
    chunk_turns = 20
    records = []
    for conv in conversations:
        entry_id = conv["entry_id"]
        user_id = f"aml_beam_{entry_id}"
        chat = conv.get("chat", [])
        if not args.skip_ingest:
            msgs = []
            for ci, start in enumerate(range(0, len(chat), chunk_turns)):
                slice_ = chat[start : start + chunk_turns]
                header = f"# {entry_id} — chunk {ci}\n# Turns {start}..{start + len(slice_) - 1} of {len(chat)}\n\n"
                body = "\n\n".join(
                    f"**{t.get('speaker', '?')} ({t.get('timestamp', '')}):** {t.get('text', '')}" for t in slice_
                )
                first_ts = slice_[0].get("timestamp") if slice_ else None
                msgs.append({
                    "messageId": f"{user_id}__chunk_{ci}",
                    "platform": "benchmark", "botId": "aml-beam",
                    "timestamp": parse_ts(first_ts), "content": header + body, "createdAt": now_ms(),
                })
            n = ingest(msgs, user_id)
            print(f"[beam] ingested {n} chunks for {entry_id}")
        for i, q in enumerate(conv.get("probing_questions", [])):
            if args.max_questions and i >= args.max_questions:
                break
            qid = q.get("question_id") or f"{entry_id}_q{i}"
            hits = search(q.get("question", ""), user_id)
            records.append({
                "id": qid,
                "question": q.get("question", ""),
                "category": q.get("category"),
                "retrieved_context": [h.get("content", "") for h in hits],
                "rubric_nuggets": q.get("atoms") or q.get("rubrics") or [],
                "scale": conv.get("scale") or data.get("scale"),
            })
    write_jsonl(OUT_DIR / "beam" / "input.jsonl", records)


# ---------------------------------------------------------------- personamem

PERSONAMEM_DIR = BENCH_ROOT / "personamem-v2" / "dataset"

MEMORY_CONTEXT_PREFIX = (
    "The following are relevant memories retrieved from the user's earlier "
    "conversation history. Use them to personalize your response:\n\n"
)


def unwrap_user_query(raw: str) -> str:
    """CSV user_query cells are Python dict reprs: {'role': 'user', 'content': '...'}."""
    text = str(raw or "").strip()
    if text.startswith("{"):
        try:
            parsed = ast.literal_eval(text)
            if isinstance(parsed, dict):
                return str(parsed.get("content", parsed.get("text", text)))
        except (ValueError, SyntaxError):
            pass
    return text


def parse_incorrect_answers(raw: str) -> list[str]:
    text = str(raw or "").strip()
    if not text:
        return []
    for parser in (json.loads, ast.literal_eval):
        try:
            parsed = parser(text)
            if isinstance(parsed, list):
                return [str(x) for x in parsed]
        except (ValueError, SyntaxError):
            continue
    # heuristic fallback: strip brackets and split on '", "' / "', '"
    inner = text.lstrip("[").rstrip("]")
    return [s.strip().strip("\"'") for s in re.split(r"[\"'],?\s+[\"']", inner) if s.strip().strip("\"'")]


def run_personamem(args) -> None:
    csv_path = PERSONAMEM_DIR / "benchmark.csv"
    with csv_path.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    # group questions by persona, preserving CSV order
    personas: dict[str, dict] = {}
    for row in rows:
        pid = row["persona_id"]
        entry = personas.setdefault(pid, {"history_link": row.get("chat_history_32k_link", ""), "questions": []})
        entry["questions"].append(row)
    persona_ids = list(personas.keys())
    if args.limit:
        persona_ids = persona_ids[: args.limit]

    chunk_msgs = 20
    records = []
    for pid in persona_ids:
        entry = personas[pid]
        questions = entry["questions"]
        if args.max_questions:
            questions = questions[: args.max_questions]
        if not questions:
            continue
        user_id = f"aml_personamem_{pid}"
        if not args.skip_ingest:
            history_path = PERSONAMEM_DIR / entry["history_link"]
            chat = json.loads(history_path.read_text(encoding="utf-8"))["chat_history"]
            msgs = []
            for ci, start in enumerate(range(0, len(chat), chunk_msgs)):
                slice_ = chat[start : start + chunk_msgs]
                header = f"# Persona {pid} conversation — chunk {ci}\n# Messages {start}..{start + len(slice_) - 1} of {len(chat)}\n\n"
                body = "\n\n".join(f"{m.get('role', '?').capitalize()}: {m.get('content', '')}" for m in slice_)
                msgs.append({
                    "messageId": f"{user_id}__chunk_{ci}",
                    "platform": "benchmark", "botId": "aml-personamem",
                    "timestamp": now_ms(), "content": header + body, "createdAt": now_ms(),
                })
            n = ingest(msgs, user_id)
            print(f"[personamem] ingested {n} chunks for persona {pid}")
        for i, q in enumerate(questions):
            query = unwrap_user_query(q.get("user_query", ""))
            hits = search(query, user_id)
            memory_block = MEMORY_CONTEXT_PREFIX + "\n\n".join(h.get("content", "") for h in hits) if hits else ""
            chat_history = [{"role": "system", "content": memory_block}] if memory_block else []
            records.append({
                "id": f"persona{pid}_q{i}",
                "persona_id": pid,
                "chat_history": chat_history,
                "user_query": query,
                "correct_answer": q.get("correct_answer", ""),
                "incorrect_answers": parse_incorrect_answers(q.get("incorrect_answers", "")),
                "preference": q.get("preference", ""),
            })
    write_jsonl(OUT_DIR / "personamem" / "input.jsonl", records)


# ---------------------------------------------------------------- scriptmem

SCRIPTMEM_DIR = BENCH_ROOT / "scriptmem" / "dataset" / "raw"
SCRIPTMEM_FILES = ("angry.json", "enemy.json", "friends.json", "man_earth.json")
SCRIPTMEM_SCRIPTS_DIR = BENCH_ROOT / "scriptmem" / "dataset" / "scripts"
SCRIPTMEM_TITLES = {
    "angry": "12 Angry Men",
    "enemy": "An Enemy of the People",
    "friends": "Friends",
    "man_earth": "The Man from Earth",
}

# ScriptMem renames the six Friends leads in its (private) conversation text;
# the mapping below was inferred from the public questions (e.g. "Bennett's
# ex-wife" + Carol, "Dexter's mom" + Nora Bing, Roger dating "Fiona").
FRIENDS_RENAME_FULL = [
    ("Ross Geller", "Bennett Geller"),
    ("Monica Geller", "Chloe Geller"),
    ("Rachel Green", "Ariel Green"),
    ("Chandler Bing", "Dexter Bing"),
    ("Joey Tribbiani", "Ethan Tribbiani"),
    ("Phoebe Buffay", "Fiona Buffay"),
]
FRIENDS_RENAME_FIRST = [
    ("Ross", "Bennett"), ("Monica", "Chloe"), ("Rachel", "Ariel"),
    ("Chandler", "Dexter"), ("Joey", "Ethan"), ("Phoebe", "Fiona"),
    ("Rach", "Ariel"), ("Pheebs", "Fiona"),
]
# NBC air dates, Friends season 1 (verified against thetvdb/next-episode).
FRIENDS_S1_AIR_DATES = [
    "September 22, 1994", "September 29, 1994", "October 6, 1994",
    "October 13, 1994", "October 20, 1994", "October 27, 1994",
    "November 3, 1994", "November 10, 1994", "November 17, 1994",
    "December 15, 1994", "January 5, 1995", "January 12, 1995",
    "January 19, 1995", "February 9, 1995", "February 16, 1995",
    "February 23, 1995", "February 23, 1995", "March 2, 1995",
    "March 9, 1995", "April 6, 1995", "April 27, 1995",
    "May 4, 1995", "May 11, 1995", "May 18, 1995",
]


def rename_friends(text: str) -> str:
    for old, new in FRIENDS_RENAME_FULL:
        text = text.replace(old, new)
    for old, new in FRIENDS_RENAME_FIRST:
        text = re.sub(rf"\b{re.escape(old)}\b", new, text)
    return text


def chunk_lines(text: str, size: int = 5000) -> list[str]:
    chunks: list[str] = []
    buf = ""
    for line in text.splitlines():
        if buf and len(buf) + len(line) + 1 > size:
            chunks.append(buf)
            buf = ""
        buf = f"{buf}\n{line}" if buf else line
    if buf:
        chunks.append(buf)
    return chunks


def scriptmem_real_sessions(source: str) -> list[dict] | None:
    """Build sessions from locally sourced script text (dataset/scripts/).
    Returns None when no real text is available for the source."""
    sdir = SCRIPTMEM_SCRIPTS_DIR
    if source == "angry":
        path = sdir / "twelve_angry_men_play.txt"
        if not path.exists():
            return None
        text = path.read_text(encoding="utf-8")
        return [{"key": f"part_{i + 1:02d}", "date": "Unknown", "text": c}
                for i, c in enumerate(chunk_lines(text)) if c.strip()]
    if source == "enemy":
        path = sdir / "enemy_gutenberg2446.txt"
        if not path.exists():
            return None
        text = path.read_text(encoding="utf-8")
        start = re.search(r"\*\*\* START OF [^\n]*\n", text)
        end = re.search(r"\*\*\* END OF [^\n]*", text)
        if start:
            text = text[start.end():]
        if end:
            text = text[: end.start()]
        return [{"key": f"part_{i + 1:02d}", "date": "Unknown", "text": c}
                for i, c in enumerate(chunk_lines(text)) if c.strip()]
    if source == "man_earth":
        path = sdir / "man_earth_transcript.txt"
        if not path.exists():
            return None
        text = path.read_text(encoding="utf-8")
        return [{"key": f"part_{i + 1:02d}", "date": "Unknown", "text": c}
                for i, c in enumerate(chunk_lines(text)) if c.strip()]
    if source == "friends":
        path = sdir / "friends_season_01.json"
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        sessions: list[dict] = []
        for ep in data["episodes"]:
            m = re.search(r"_e(\d+)$", ep["episode_id"])
            ep_num = int(m.group(1)) if m else 0
            date = FRIENDS_S1_AIR_DATES[ep_num - 1] if 1 <= ep_num <= len(FRIENDS_S1_AIR_DATES) else "Unknown"
            for sc in ep["scenes"]:
                lines = []
                for u in sc["utterances"]:
                    t = (u.get("transcript") or "").strip()
                    if not t:
                        continue
                    speakers = u.get("speakers") or []
                    speaker = ", ".join(speakers) or "Narration"
                    if any("scene" in s.lower() for s in speakers):
                        speaker = "Narration"
                    lines.append(f"{rename_friends(speaker)}: {rename_friends(t)}")
                if lines:
                    sessions.append({
                        "key": sc["scene_id"],
                        "date": date,
                        "text": "\n".join(lines),
                    })
        return sessions
    return None


def scriptmem_session_ts(date: str) -> int:
    try:
        return int(datetime.strptime(date, "%B %d, %Y").replace(tzinfo=timezone.utc).timestamp() * 1000)
    except ValueError:
        return now_ms()


def run_scriptmem(args) -> None:
    # Upstream ScriptMem does not publish the original script text; the
    # `conversation` field only carries a synthetic schema example. When real
    # script text is available under dataset/scripts/ (see README), we ingest
    # that instead, under a separate userId namespace so the placeholder
    # memories never mix with real ones.
    records = []
    for filename in SCRIPTMEM_FILES:
        source = filename[:-5]
        data = json.loads((SCRIPTMEM_DIR / filename).read_text(encoding="utf-8"))
        if args.limit:
            data = data[: args.limit]
        real_sessions = scriptmem_real_sessions(source)
        for sample_index, sample in enumerate(data):
            sample_id = sample.get("sample_id") or f"{source}-{sample_index}"
            user_id = f"aml_scriptmem_{source}_{sample_id}"
            conv = sample.get("conversation") or {}
            # the public release nests its synthetic schema example under
            # `format_example`; real (platform-side) conversations carry
            # top-level session_* keys — support both layouts
            sessions_source = conv
            if not any(k.startswith("session_") for k in conv) and isinstance(conv.get("format_example"), dict):
                sessions_source = conv["format_example"]
            speakers = sessions_source.get("speakers") or []
            if real_sessions is not None:
                user_id += "_real"
                speakers = [SCRIPTMEM_TITLES[source]]
            if not args.skip_ingest:
                msgs = []
                if real_sessions is not None:
                    for s in real_sessions:
                        ts = scriptmem_session_ts(s["date"])
                        content = f"# {SCRIPTMEM_TITLES[source]} — {s['key']}\n# Date: {s['date']}\n\n{s['text']}"
                        msgs.append({
                            "messageId": f"{user_id}__{s['key']}",
                            "platform": "benchmark", "botId": "aml-scriptmem",
                            "timestamp": ts, "content": content, "createdAt": now_ms(),
                        })
                else:
                    for key in sorted(sessions_source.keys()):
                        if not key.startswith("session_") or key.endswith("_date_time"):
                            continue
                        turns = sessions_source.get(key) or []
                        if not isinstance(turns, list) or not turns:
                            continue
                        date = sessions_source.get(f"{key}_date_time", "")
                        body = "\n".join(
                            f"{t.get('speaker') or 'Narration'}: {t.get('text', '')}" for t in turns
                        )
                        content = f"# {source} {sample_id} — {key}\n# Date: {date}\n\n{body}"
                        msgs.append({
                            "messageId": f"{user_id}__{key}",
                            "platform": "benchmark", "botId": "aml-scriptmem",
                            "timestamp": now_ms(), "content": content, "createdAt": now_ms(),
                        })
                if msgs:
                    n = ingest(msgs, user_id)
                    print(f"[scriptmem] ingested {n} sessions for {source}:{sample_id} ({'real text' if real_sessions is not None else 'placeholder'})")
            for i, qa in enumerate(sample.get("qa", [])):
                if args.max_questions and i >= args.max_questions:
                    break
                qa_id = f"{source}:{sample_id}#q{i:04d}"
                hits = search(qa["question"], user_id)
                records.append({
                    "id": qa_id,
                    "qa_id": qa_id,
                    "dataset": source,
                    "question": qa["question"],
                    "qa_type": qa.get("qa_type"),
                    "speaker_1_name": speakers[0] if len(speakers) > 0 else "speaker 1",
                    "speaker_1_memories": "\n\n".join(h.get("content", "") for h in hits),
                    "speaker_2_name": speakers[1] if len(speakers) > 1 else "speaker 2",
                    "speaker_2_memories": "",
                })
    write_jsonl(OUT_DIR / "scriptmem" / "input.jsonl", records)


def main() -> None:
    ap = argparse.ArgumentParser(description="Ingest local datasets into OpenContext and emit AML pipeline input JSONL")
    ap.add_argument("bench", choices=["longmemeval", "locomo", "clbench", "beam", "personamem", "scriptmem"])
    ap.add_argument("--limit", type=int, default=None, help="limit number of dataset entries (conversations/samples)")
    ap.add_argument("--samples", default=None, help="comma-separated sample ids (longmemeval/locomo)")
    ap.add_argument("--dataset", default="sample_conversation.json", help="beam dataset filename under beam/dataset/")
    ap.add_argument("--skip-ingest", action="store_true", help="reuse already-ingested memories (re-retrieve only)")
    ap.add_argument("--max-questions", type=int, default=None, help="cap questions per sample/conversation (locomo/beam/personamem)")
    args = ap.parse_args()

    health()
    print(f"[aml-local] daemon={BASE} top_k={TOP_K} bench={args.bench}")
    {"longmemeval": run_longmemeval, "locomo": run_locomo, "clbench": run_clbench, "beam": run_beam, "personamem": run_personamem, "scriptmem": run_scriptmem}[args.bench](args)


if __name__ == "__main__":
    main()
