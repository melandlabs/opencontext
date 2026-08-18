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

Env:
  OPENCONTEXT_URL   default http://127.0.0.1:7421
  AML_TOP_K         default 10
"""
from __future__ import annotations

import argparse
import json
import os
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


def main() -> None:
    ap = argparse.ArgumentParser(description="Ingest local datasets into OpenContext and emit AML pipeline input JSONL")
    ap.add_argument("bench", choices=["longmemeval", "locomo", "clbench", "beam"])
    ap.add_argument("--limit", type=int, default=None, help="limit number of dataset entries (conversations/samples)")
    ap.add_argument("--samples", default=None, help="comma-separated sample ids (longmemeval/locomo)")
    ap.add_argument("--dataset", default="sample_conversation.json", help="beam dataset filename under beam/dataset/")
    ap.add_argument("--skip-ingest", action="store_true", help="reuse already-ingested memories (re-retrieve only)")
    ap.add_argument("--max-questions", type=int, default=None, help="cap questions per sample/conversation (locomo/beam)")
    args = ap.parse_args()

    health()
    print(f"[aml-local] daemon={BASE} top_k={TOP_K} bench={args.bench}")
    {"longmemeval": run_longmemeval, "locomo": run_locomo, "clbench": run_clbench, "beam": run_beam}[args.bench](args)


if __name__ == "__main__":
    main()
