"""Retrieve OpenContext memories and emit AML-compatible benchmark JSONL.

This is the local retrieval stage used by ``run_aml_local.ps1``. It reads one
of the six existing benchmark formats, writes each sample to an isolated
OpenContext ``userId``, searches that same scope, and emits the input expected
by the vendored AML answer/evaluation pipelines.
"""

from __future__ import annotations

import argparse
import ast
import csv
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


BENCH_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT_DIR = Path(__file__).resolve().parent / "outputs"
BATCH_SIZE = 25
BENCHMARKS = ("longmemeval", "locomo", "clbench", "beam", "personamem", "scriptmem")
OUTPUT_NAMES = {
    "longmemeval": "longmemeval-s",
    "locomo": "locomo-refined",
    "clbench": "clbench",
    "beam": "beam",
    "personamem": "personamem",
    "scriptmem": "scriptmem",
}
SCRIPTMEM_FILES = ("angry.json", "enemy.json", "friends.json", "man_earth.json")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(f"[aml-local] wrote {len(records)} records -> {path}")


def parse_timestamp(value: Any, fallback: int) -> int:
    if isinstance(value, (int, float)):
        return int(value)
    if value:
        try:
            return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            pass
    return fallback


def iso_from_ms(value: Any) -> str | None:
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def scope_id(benchmark: str, dataset: Path, sample_id: str) -> str:
    dataset_name = dataset.name or dataset.parent.name
    digest = hashlib.sha256(
        f"{benchmark}\0{dataset_name}\0{sample_id}".encode("utf-8")
    ).hexdigest()[:16]
    return f"aml_{benchmark}_{digest}"


def message_id(user_id: str, unit_id: str) -> str:
    digest = hashlib.sha256(f"{user_id}\0{unit_id}".encode("utf-8")).hexdigest()[:16]
    return f"{user_id}:{digest}"


def raw_message(
    benchmark: str,
    user_id: str,
    unit_id: str,
    content: str,
    timestamp: int,
) -> dict[str, Any]:
    return {
        "messageId": message_id(user_id, unit_id),
        "userId": user_id,
        "platform": "benchmark",
        "botId": f"aml-{benchmark}",
        "timestamp": timestamp,
        "createdAt": timestamp,
        "content": content,
    }


def hit_texts(hits: list[dict[str, Any]]) -> list[str]:
    return [str(hit.get("content", "")) for hit in hits]


def selected_ids(raw: str | None) -> set[str] | None:
    if not raw:
        return None
    values = {part.strip() for part in raw.split(",") if part.strip()}
    return values or None


def dataset_sample_ids(benchmark: str, dataset: Path) -> set[str]:
    """Read only the identifiers needed to validate a requested sample filter."""
    if benchmark == "scriptmem":
        identifiers: set[str] = set()
        for filename in SCRIPTMEM_FILES:
            path = dataset / filename
            for index, entry in enumerate(read_json(path)):
                identifiers.add(str(entry.get("sample_id") or f"{path.stem}-{index}"))
        return identifiers
    if benchmark == "personamem":
        with dataset.open(newline="", encoding="utf-8") as handle:
            return {str(row["persona_id"]) for row in csv.DictReader(handle)}
    if benchmark == "clbench":
        rows = read_jsonl(dataset) if dataset.suffix == ".jsonl" else read_json(dataset)
        return {
            str((row.get("metadata") or {}).get("task_id") or f"cl_{index}")
            for index, row in enumerate(rows)
        }

    payload = read_json(dataset)
    if benchmark == "beam":
        rows = payload.get("conversations", []) if isinstance(payload, dict) else payload
        return {str(row.get("entry_id")) for row in rows}
    key = "question_id" if benchmark == "longmemeval" else "sample_id"
    return {str(row.get(key)) for row in payload}


def check_writable_directory(path: Path) -> bool:
    candidate = path.resolve()
    while not candidate.exists() and candidate.parent != candidate:
        candidate = candidate.parent
    return candidate.is_dir() and os.access(candidate, os.W_OK)


def collect_preflight_errors(
    benchmark: str,
    dataset: Path,
    out_dir: Path,
    client: "OpenContextClient",
    *,
    limit: int | None,
    samples: set[str] | None,
    max_questions: int | None,
) -> list[str]:
    """Aggregate local retrieval failures before ingest or search side effects."""
    errors: list[str] = []
    if limit is not None and limit < 1:
        errors.append("--limit must be a positive integer")
    if max_questions is not None and max_questions < 1:
        errors.append("--max-questions must be a positive integer")

    dataset_readable = dataset.exists() and os.access(dataset, os.R_OK)
    if not dataset_readable:
        errors.append(f"dataset is missing or unreadable: {dataset.resolve()}")
    else:
        try:
            available = dataset_sample_ids(benchmark, dataset)
            if not available:
                errors.append(f"dataset contains no benchmark samples: {dataset.resolve()}")
            elif samples:
                missing = sorted(samples - available)
                if missing:
                    errors.append(f"unknown --samples value(s): {', '.join(missing)}")
        except Exception as error:  # noqa: BLE001 - malformed datasets must join the aggregate report
            errors.append(f"dataset validation failed: {error}")

    if not check_writable_directory(out_dir):
        errors.append(f"output path is not writable: {out_dir.resolve()}")
    try:
        client.health()
    except Exception as error:  # noqa: BLE001 - preflight must aggregate connection failures
        errors.append(f"OpenContext daemon is unavailable at {client.base_url}: {error}")
    return errors


class OpenContextClient:
    def __init__(self, base_url: str, top_k: int, reasoning: str = "none") -> None:
        self.base_url = base_url.rstrip("/")
        self.top_k = top_k
        self.reasoning = reasoning

    def _post(self, path: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
        request = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def health(self) -> None:
        with urllib.request.urlopen(self.base_url + "/health", timeout=10) as response:
            if response.status != 200:
                raise RuntimeError(f"OpenContext daemon unhealthy: HTTP {response.status}")

    def ingest(self, user_id: str, messages: list[dict[str, Any]]) -> int:
        count = 0
        for start in range(0, len(messages), BATCH_SIZE):
            batch = messages[start : start + BATCH_SIZE]
            result = self._post(
                "/v1/raw-messages",
                {"userId": user_id, "messages": batch, "embedOnInsert": True},
                timeout=600,
            )
            count += int(result.get("count", len(batch)))
        return count

    def search(self, user_id: str, query: str) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {
            "userId": user_id,
            "query": query,
            "limit": self.top_k,
            "sources": ["memory"],
        }
        if self.reasoning != "none":
            payload["reasoningStrategy"] = self.reasoning
        result = self._post("/v1/search", payload, timeout=600 if self.reasoning != "none" else 120)
        hits = result.get("results", [])
        if not isinstance(hits, list):
            raise TypeError("OpenContext /v1/search response must contain results[]")
        return hits


def run_longmemeval(
    dataset: Path,
    client: OpenContextClient,
    *,
    limit: int | None,
    samples: set[str] | None,
    max_questions: int | None,
    skip_ingest: bool,
) -> list[dict[str, Any]]:
    del max_questions
    entries = read_json(dataset)
    if samples:
        entries = [entry for entry in entries if str(entry.get("question_id")) in samples]
    if limit:
        entries = entries[:limit]

    records: list[dict[str, Any]] = []
    for entry in entries:
        question_id = str(entry["question_id"])
        user_id = scope_id("longmemeval", dataset, question_id)
        messages: list[dict[str, Any]] = []
        sessions = entry.get("haystack_sessions") or []
        session_ids = entry.get("haystack_session_ids") or []
        dates = entry.get("haystack_dates") or []
        for index, turns in enumerate(sessions):
            session_id = str(session_ids[index]) if index < len(session_ids) else f"session_{index}"
            date = dates[index] if index < len(dates) else None
            body = "\n".join(
                f"{'User' if turn.get('role') == 'user' else 'Assistant'}: {turn.get('content', '')}"
                for turn in turns
            )
            content = f"# Conversation Session {session_id}\n# Date: {date or ''}\n\n{body}"
            messages.append(
                raw_message(
                    "longmemeval",
                    user_id,
                    session_id,
                    content,
                    parse_timestamp(date, index + 1),
                )
            )
        if not skip_ingest and messages:
            client.ingest(user_id, messages)
        hits = client.search(user_id, str(entry["question"]))
        records.append(
            {
                "id": question_id,
                "question": entry["question"],
                "question_type": entry.get("question_type"),
                "retrieved_context": hit_texts(hits),
                "gold_answer": entry.get("answer", ""),
            }
        )
    return records


def run_locomo(
    dataset: Path,
    client: OpenContextClient,
    *,
    limit: int | None,
    samples: set[str] | None,
    max_questions: int | None,
    skip_ingest: bool,
) -> list[dict[str, Any]]:
    entries = read_json(dataset)
    if samples:
        entries = [entry for entry in entries if str(entry.get("sample_id")) in samples]
    if limit:
        entries = entries[:limit]

    records: list[dict[str, Any]] = []
    for entry in entries:
        sample_id = str(entry["sample_id"])
        user_id = scope_id("locomo", dataset, sample_id)
        conversation = entry.get("conversation") or {}
        messages: list[dict[str, Any]] = []
        session_keys = sorted(
            key
            for key in conversation
            if key.startswith("session_") and not key.endswith("_date_time")
        )
        for index, key in enumerate(session_keys):
            turns = conversation.get(key) or []
            if not isinstance(turns, list) or not turns:
                continue
            date = conversation.get(f"{key}_date_time")
            body = "\n".join(f"{turn.get('speaker', '?')}: {turn.get('text', '')}" for turn in turns)
            content = f"# Conversation {key}\n# Date: {date or ''}\n\n{body}"
            messages.append(
                raw_message("locomo", user_id, key, content, parse_timestamp(date, index + 1))
            )
        if not skip_ingest and messages:
            client.ingest(user_id, messages)

        questions = entry.get("qa") or entry.get("qa_pairs") or []
        if max_questions:
            questions = questions[:max_questions]
        for index, question in enumerate(questions):
            answer = question.get("answer")
            if answer is None or (isinstance(answer, str) and not answer.strip()):
                continue
            hits = client.search(user_id, str(question["question"]))
            records.append(
                {
                    "id": f"{sample_id}__q{index}",
                    "question": question["question"],
                    "category": question.get("category"),
                    "retrieved_context": hit_texts(hits),
                    "gold_answer": str(answer),
                }
            )
    return records


def run_clbench(
    dataset: Path,
    client: OpenContextClient,
    *,
    limit: int | None,
    samples: set[str] | None,
    max_questions: int | None,
    skip_ingest: bool,
) -> list[dict[str, Any]]:
    del max_questions
    rows = read_jsonl(dataset) if dataset.suffix == ".jsonl" else read_json(dataset)
    if samples:
        rows = [
            row
            for index, row in enumerate(rows)
            if str((row.get("metadata") or {}).get("task_id") or f"cl_{index}") in samples
        ]
    if limit:
        rows = rows[:limit]

    records: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        metadata = row.get("metadata") or {}
        task_id = str(metadata.get("task_id") or f"cl_{index}")
        user_id = scope_id("clbench", dataset, task_id)
        source_messages = row.get("messages") or []
        context_messages = source_messages[:-1]
        question = str(source_messages[-1].get("content", "")) if source_messages else ""
        messages = [
            raw_message(
                "clbench",
                user_id,
                f"message_{message_index}",
                f"{str(message.get('role', 'user')).capitalize()}: {message.get('content', '')}",
                message_index + 1,
            )
            for message_index, message in enumerate(context_messages)
        ]
        if not skip_ingest and messages:
            client.ingest(user_id, messages)
        hits = client.search(user_id, question[:2000])
        selected = []
        for hit in hits:
            item: dict[str, Any] = {"text": str(hit.get("content", ""))}
            metadata_value = hit.get("metadata") or {}
            created_at = iso_from_ms(metadata_value.get("timestamp") or metadata_value.get("createdAt"))
            if created_at:
                item["created_at"] = created_at
            selected.append(item)
        records.append(
            {
                "id": task_id,
                "question": question,
                "system_prompt": "",
                "retrieval": {"selected": selected},
                "rubrics": row.get("rubrics", []),
                "metadata": metadata,
            }
        )
    return records


def run_beam(
    dataset: Path,
    client: OpenContextClient,
    *,
    limit: int | None,
    samples: set[str] | None,
    max_questions: int | None,
    skip_ingest: bool,
) -> list[dict[str, Any]]:
    payload = read_json(dataset)
    conversations = payload.get("conversations", []) if isinstance(payload, dict) else payload
    if samples:
        conversations = [entry for entry in conversations if str(entry.get("entry_id")) in samples]
    if limit:
        conversations = conversations[:limit]

    records: list[dict[str, Any]] = []
    for entry in conversations:
        entry_id = str(entry["entry_id"])
        user_id = scope_id("beam", dataset, entry_id)
        chat = entry.get("chat") or []
        messages: list[dict[str, Any]] = []
        for chunk_index, start in enumerate(range(0, len(chat), 20)):
            chunk = chat[start : start + 20]
            body = "\n".join(
                f"{turn.get('speaker', '?')}: {turn.get('text', '')}" for turn in chunk
            )
            timestamp = parse_timestamp(chunk[0].get("timestamp") if chunk else None, chunk_index + 1)
            messages.append(raw_message("beam", user_id, f"chunk_{chunk_index}", body, timestamp))
        if not skip_ingest and messages:
            client.ingest(user_id, messages)

        questions = entry.get("probing_questions") or []
        if max_questions:
            questions = questions[:max_questions]
        for index, question in enumerate(questions):
            question_id = str(question.get("question_id") or f"{entry_id}_q{index}")
            hits = client.search(user_id, str(question.get("question", "")))
            records.append(
                {
                    "id": question_id,
                    "question": question.get("question", ""),
                    "category": question.get("category"),
                    "retrieved_context": hit_texts(hits),
                    "rubric_nuggets": question.get("atoms") or question.get("rubrics") or [],
                    "scale": entry.get("scale") or (payload.get("scale") if isinstance(payload, dict) else None),
                }
            )
    return records


def unwrap_user_query(value: Any) -> str:
    text = str(value or "").strip()
    if text.startswith("{"):
        try:
            parsed = ast.literal_eval(text)
            if isinstance(parsed, dict):
                return str(parsed.get("content", parsed.get("text", text)))
        except (SyntaxError, ValueError):
            pass
    return text


def parse_incorrect_answers(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    text = str(value or "").strip()
    if not text:
        return []
    for parser in (json.loads, ast.literal_eval):
        try:
            parsed = parser(text)
            if isinstance(parsed, list):
                return [str(item) for item in parsed]
        except (json.JSONDecodeError, SyntaxError, ValueError):
            pass
    return []


def run_personamem(
    dataset: Path,
    client: OpenContextClient,
    *,
    limit: int | None,
    samples: set[str] | None,
    max_questions: int | None,
    skip_ingest: bool,
) -> list[dict[str, Any]]:
    with dataset.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    personas: dict[str, dict[str, Any]] = {}
    for row in rows:
        persona_id = str(row["persona_id"])
        persona = personas.setdefault(
            persona_id,
            {"history_link": row.get("chat_history_32k_link", ""), "questions": []},
        )
        persona["questions"].append(row)

    persona_ids = [persona_id for persona_id in personas if not samples or persona_id in samples]
    if limit:
        persona_ids = persona_ids[:limit]

    records: list[dict[str, Any]] = []
    for persona_id in persona_ids:
        persona = personas[persona_id]
        user_id = scope_id("personamem", dataset, persona_id)
        history_path = dataset.parent / str(persona["history_link"])
        history_payload = read_json(history_path)
        history = history_payload.get("chat_history", history_payload)
        messages: list[dict[str, Any]] = []
        for chunk_index, start in enumerate(range(0, len(history), 20)):
            chunk = history[start : start + 20]
            body = "\n".join(
                f"{str(message.get('role', 'user')).capitalize()}: {message.get('content', '')}"
                for message in chunk
            )
            messages.append(
                raw_message("personamem", user_id, f"chunk_{chunk_index}", body, chunk_index + 1)
            )
        if not skip_ingest and messages:
            client.ingest(user_id, messages)

        questions = persona["questions"]
        if max_questions:
            questions = questions[:max_questions]
        for index, question in enumerate(questions):
            query = unwrap_user_query(question.get("user_query", ""))
            hits = client.search(user_id, query)
            memory = "\n\n".join(hit_texts(hits))
            chat_history = []
            if memory:
                chat_history.append(
                    {
                        "role": "system",
                        "content": "Relevant memories from earlier conversation:\n\n" + memory,
                    }
                )
            records.append(
                {
                    "id": f"persona{persona_id}_q{index}",
                    "persona_id": persona_id,
                    "chat_history": chat_history,
                    "user_query": query,
                    "correct_answer": question.get("correct_answer", ""),
                    "incorrect_answers": parse_incorrect_answers(question.get("incorrect_answers", "")),
                    "preference": question.get("preference", ""),
                }
            )
    return records


def session_sort_key(key: str) -> tuple[int, str]:
    match = re.search(r"(\d+)", key)
    return (int(match.group(1)) if match else 0, key)


def run_scriptmem(
    dataset: Path,
    client: OpenContextClient,
    *,
    limit: int | None,
    samples: set[str] | None,
    max_questions: int | None,
    skip_ingest: bool,
) -> list[dict[str, Any]]:
    paths = [dataset / filename for filename in SCRIPTMEM_FILES]
    missing = [path.name for path in paths if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"ScriptMem dataset is missing: {', '.join(missing)}")

    records: list[dict[str, Any]] = []
    for path in paths:
        source = path.stem
        entries = read_json(path)
        if samples:
            entries = [entry for entry in entries if str(entry.get("sample_id")) in samples]
        if limit:
            entries = entries[:limit]
        for sample_index, entry in enumerate(entries):
            sample_id = str(entry.get("sample_id") or f"{source}-{sample_index}")
            user_id = scope_id("scriptmem", dataset, f"{source}:{sample_id}")
            conversation = entry.get("conversation") or {}
            if not any(key.startswith("session_") for key in conversation):
                candidate = conversation.get("format_example")
                if isinstance(candidate, dict):
                    conversation = candidate
            speakers = conversation.get("speakers") or []
            session_keys = sorted(
                (
                    key
                    for key in conversation
                    if key.startswith("session_") and not key.endswith("_date_time")
                ),
                key=session_sort_key,
            )
            messages: list[dict[str, Any]] = []
            for session_index, key in enumerate(session_keys):
                turns = conversation.get(key) or []
                if not isinstance(turns, list) or not turns:
                    continue
                date = conversation.get(f"{key}_date_time")
                body = "\n".join(
                    f"{turn.get('speaker') or 'Narration'}: {turn.get('text', '')}" for turn in turns
                )
                messages.append(
                    raw_message(
                        "scriptmem",
                        user_id,
                        key,
                        body,
                        parse_timestamp(date, session_index + 1),
                    )
                )
            if not skip_ingest and messages:
                client.ingest(user_id, messages)

            questions = entry.get("qa") or []
            if max_questions:
                questions = questions[:max_questions]
            for question_index, question in enumerate(questions):
                question_id = f"{source}:{sample_id}#q{question_index:04d}"
                hits = client.search(user_id, str(question["question"]))
                records.append(
                    {
                        "id": question_id,
                        "qa_id": question_id,
                        "dataset": source,
                        "question": question["question"],
                        "qa_type": question.get("qa_type"),
                        "speaker_1_name": speakers[0] if len(speakers) > 0 else "speaker 1",
                        "speaker_1_memories": "\n\n".join(hit_texts(hits)),
                        "speaker_2_name": speakers[1] if len(speakers) > 1 else "speaker 2",
                        "speaker_2_memories": "",
                    }
                )
    return records


RUNNERS: dict[str, Callable[..., list[dict[str, Any]]]] = {
    "longmemeval": run_longmemeval,
    "locomo": run_locomo,
    "clbench": run_clbench,
    "beam": run_beam,
    "personamem": run_personamem,
    "scriptmem": run_scriptmem,
}


def default_dataset(benchmark: str, dataset_arg: str | None) -> Path:
    if dataset_arg:
        candidate = Path(dataset_arg)
        if candidate.is_absolute():
            return candidate
        if benchmark == "beam":
            return BENCH_ROOT / "beam" / "dataset" / candidate
        return candidate.resolve()
    defaults = {
        "longmemeval": BENCH_ROOT / "longmemeval" / "dataset" / "longmemeval_s_cleaned.json",
        "locomo": BENCH_ROOT / "locomo" / "dataset" / "locomo_v2.json",
        "clbench": BENCH_ROOT / "clbench-official" / "CL-bench-Life.jsonl",
        "beam": BENCH_ROOT / "beam" / "dataset" / "sample_conversation.json",
        "personamem": BENCH_ROOT / "personamem-v2" / "dataset" / "benchmark.csv",
        "scriptmem": BENCH_ROOT / "scriptmem" / "dataset" / "raw",
    }
    return defaults[benchmark]


def run_benchmark(
    benchmark: str,
    dataset: Path,
    client: OpenContextClient,
    out_dir: Path,
    *,
    limit: int | None = None,
    samples: set[str] | None = None,
    max_questions: int | None = None,
    skip_ingest: bool = False,
) -> Path:
    records = RUNNERS[benchmark](
        dataset,
        client,
        limit=limit,
        samples=samples,
        max_questions=max_questions,
        skip_ingest=skip_ingest,
    )
    output = out_dir / OUTPUT_NAMES[benchmark] / "input.jsonl"
    write_jsonl(output, records)
    return output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Ingest a local benchmark into OpenContext and emit AML-compatible input JSONL"
    )
    parser.add_argument("benchmark", choices=BENCHMARKS)
    parser.add_argument("--limit", type=int, help="limit benchmark samples/conversations")
    parser.add_argument("--samples", help="comma-separated sample IDs")
    parser.add_argument(
        "--dataset",
        help="dataset override; BEAM relative paths resolve under benchmark/beam/dataset",
    )
    parser.add_argument("--skip-ingest", action="store_true", help="reuse an already-ingested sample scope")
    parser.add_argument("--max-questions", type=int, help="cap questions per selected sample")
    parser.add_argument(
        "--preflight-only",
        action="store_true",
        help="validate local requirements without ingesting, searching, or writing output",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    parameter_errors: list[str] = []
    reasoning = os.environ.get("AML_REASONING_STRATEGY", "none").strip().lower()
    if reasoning not in {"none", "rewrite", "iterative"}:
        parameter_errors.append("AML_REASONING_STRATEGY must be none, rewrite, or iterative")
        reasoning = "none"
    try:
        top_k = int(os.environ.get("AML_TOP_K", "10"))
    except ValueError:
        parameter_errors.append("AML_TOP_K must be an integer")
        top_k = 10
    if top_k < 1:
        parameter_errors.append("AML_TOP_K must be at least 1")
        top_k = 10

    dataset = default_dataset(args.benchmark, args.dataset)
    out_dir = Path(os.environ.get("AML_OUT_DIR", DEFAULT_OUT_DIR)).resolve()
    client = OpenContextClient(
        os.environ.get("OPENCONTEXT_URL", "http://127.0.0.1:7421"),
        top_k,
        reasoning,
    )
    samples = selected_ids(args.samples)
    errors = parameter_errors + collect_preflight_errors(
        args.benchmark,
        dataset,
        out_dir,
        client,
        limit=args.limit,
        samples=samples,
        max_questions=args.max_questions,
    )
    if errors:
        print("AML retrieval preflight failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 2
    print(
        f"[aml-local] daemon={client.base_url} top_k={top_k} "
        f"reasoning={reasoning} benchmark={args.benchmark}"
    )
    if args.preflight_only:
        print("[aml-local] preflight passed")
        return 0
    run_benchmark(
        args.benchmark,
        dataset,
        client,
        out_dir,
        limit=args.limit,
        samples=samples,
        max_questions=args.max_questions,
        skip_ingest=args.skip_ingest,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
