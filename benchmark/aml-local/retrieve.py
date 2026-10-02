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
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from contextlib import closing
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
SOCKET_RETRY_DELAYS = (5, 10, 20, 30, 60, 60, 60, 60)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    print(f"[aml-local] wrote {len(records)} records -> {path}")


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def load_beam_resume_ids(path: Path) -> set[str]:
    """Read committed Add message IDs without modifying the running store."""
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)) as connection:
        return {
            row[0]
            for row in connection.execute("SELECT message_id FROM raw_messages WHERE platform = 'aml'")
        }


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


def split_clbench_inline_task(content: str) -> tuple[str, str] | None:
    """Split CL-bench-Life's one-message ``context <|TASK|> question`` form."""
    marker = "<|TASK|>"
    if marker not in content:
        return None
    context, question = content.rsplit(marker, 1)
    context = context.strip()
    question = question.strip()
    if not context or not question:
        return None
    return context, question


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

    def _post(self, path: str, payload: dict[str, Any], timeout: int, *, headers: dict[str, str] | None = None) -> dict[str, Any]:
        request = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", **(headers or {})},
            method="POST",
        )
        for attempt in range(len(SOCKET_RETRY_DELAYS) + 1):
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.URLError as exc:
                reason = exc.reason
                no_buffer = isinstance(reason, OSError) and (
                    getattr(reason, "winerror", None) == 10055 or reason.errno == 10055
                )
                if not no_buffer or attempt == len(SOCKET_RETRY_DELAYS):
                    raise
                delay = SOCKET_RETRY_DELAYS[attempt]
                print(
                    f"[aml-local] socket 10055 on {path}; retry {attempt + 1}/{len(SOCKET_RETRY_DELAYS)} in {delay}s",
                    file=sys.stderr,
                    flush=True,
                )
                time.sleep(delay)
        raise AssertionError("unreachable")

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


class AmlClient(OpenContextClient):
    """Exercise the same Add/Search boundary that AML calls in production."""

    def health(self) -> None:
        with urllib.request.urlopen(self.base_url + "/health", timeout=10) as response:
            if response.status != 200:
                raise RuntimeError(f"AML adapter unhealthy: HTTP {response.status}")
            status = json.loads(response.read().decode("utf-8"))
        if status.get("ok") is not True or (status.get("retrieval") or {}).get("rerankerReady") is not True:
            raise RuntimeError("AML adapter is not ready with an active reranker")

    def add(self, request_id: str, user_id: str, session_id: str, messages: list[dict[str, Any]]) -> None:
        result = self._post(
            "/add",
            {"request_id": request_id, "user_id": user_id, "session_id": session_id, "messages": messages},
            timeout=1800,
        )
        if result != {"success": True, "request_id": request_id, "user_id": user_id, "session_id": session_id}:
            raise RuntimeError(f"AML Add returned an invalid acknowledgement for {request_id}")

    def search(self, user_id: str, query: str) -> list[dict[str, Any]]:
        return self.search_with_diagnostics(user_id, query, include_diagnostics=False)[0]

    def search_with_diagnostics(
        self, user_id: str, query: str, *, include_diagnostics: bool = True
    ) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
        if self.reasoning != "none" and not include_diagnostics:
            raise ValueError("BEAM local reasoning experiments require retrieval diagnostics")
        headers = {"X-OpenContext-Local-Diagnostics": "1"} if include_diagnostics else {}
        if self.reasoning != "none":
            headers["X-OpenContext-Local-Reasoning"] = self.reasoning
        result = self._post(
            "/search", {"query": query, "user_id": user_id, "top_k": self.top_k}, timeout=1800,
            headers=headers or None,
        )
        hits = result.get("data")
        if not isinstance(hits, list) or len(hits) > self.top_k:
            raise RuntimeError("AML Search returned invalid or over-limit data")
        for hit in hits:
            if not isinstance(hit, dict) or not isinstance(hit.get("id"), str) or not hit["id"] or not isinstance(hit.get("content"), str) or not hit["content"]:
                raise RuntimeError("AML Search returned invalid memory content")
        diagnostics = result.get("_local_diagnostics") if include_diagnostics else None
        if include_diagnostics:
            retrieval = diagnostics.get("retrieval") if isinstance(diagnostics, dict) else None
            reranker = retrieval.get("reranker") if isinstance(retrieval, dict) else None
            if not isinstance(retrieval, dict) or not isinstance(retrieval.get("fusedBeforeRerank"), list) or not isinstance(reranker, dict) or reranker.get("enabled") is not True:
                raise RuntimeError("AML local Search did not provide active reranker diagnostics; restart the updated adapter")
            if self.reasoning != "none":
                actual = diagnostics.get("reasoning") if isinstance(diagnostics, dict) else None
                if not isinstance(actual, dict) or actual.get("strategy") != self.reasoning:
                    raise RuntimeError(f"AML local Search did not report the requested {self.reasoning} strategy")
        return hits, diagnostics


def beam_messages(chat: list[dict[str, Any]]) -> list[dict[str, Any]]:
    messages = []
    for i, turn in enumerate(chat):
        role, content = turn.get("speaker"), turn.get("text")
        if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
            raise ValueError(f"BEAM chat[{i}] must have user/assistant speaker and non-empty text")
        message = {"role": role, "content": content}
        timestamp = turn.get("timestamp")
        if timestamp is not None:
            if isinstance(timestamp, (int, float)) and not isinstance(timestamp, bool):
                message["timestamp"] = int(timestamp)
            elif isinstance(timestamp, str):
                try:
                    date = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                except ValueError:
                    date = datetime.strptime(timestamp, "%B-%d-%Y")
                if date.tzinfo is None:
                    date = date.replace(tzinfo=timezone.utc)
                message["timestamp"] = int(date.timestamp() * 1000)
            else:
                raise ValueError(f"BEAM chat[{i}] has an invalid timestamp")
        messages.append(message)
    return messages


def beam_add_chunks(messages: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Approximate public 20-message/2,000-word Add boundaries.

    AML's frozen Adapter word counter is not published; whitespace counting
    is the reproducible local approximation, not a claim of byte parity.
    """
    chunks: list[list[dict[str, Any]]] = []
    chunk: list[dict[str, Any]] = []
    words = 0
    for message in messages:
        message_words = len(message["content"].split())
        if chunk and (len(chunk) >= 20 or words + message_words > 2000):
            chunks.append(chunk)
            chunk, words = [], 0
        chunk.append(message)
        words += message_words
    if chunk:
        chunks.append(chunk)
    return chunks


def completed_beam_add_requests(
    conversations: list[dict[str, Any]], dataset: Path, resume_message_ids: set[str]
) -> set[str]:
    """Accept only a complete prefix of Add batches from this exact dataset."""
    completed: set[str] = set()
    unmatched = set(resume_message_ids)
    missing_seen = False
    for entry in conversations:
        user_id = scope_id("beam", dataset, str(entry["entry_id"]))
        for chunk_index, chunk in enumerate(beam_add_chunks(beam_messages(entry.get("chat") or []))):
            request_id = f"{user_id}:chunk:{chunk_index}"
            ids = [f"aml:{request_id}:{index}" for index in range(len(chunk))]
            present = sum(message_id in resume_message_ids for message_id in ids)
            unmatched.difference_update(ids)
            if present == len(ids):
                if missing_seen:
                    raise ValueError(f"BEAM resume database has a non-prefix Add batch: {request_id}")
                completed.add(request_id)
            elif present:
                raise ValueError(f"BEAM resume database has a partial Add batch: {request_id}")
            else:
                missing_seen = True
    if unmatched:
        raise ValueError(f"BEAM resume database contains {len(unmatched)} messages outside this dataset selection")
    return completed


def beam_checkpoint_path(directory: Path, index: int, question_id: str) -> Path:
    digest = hashlib.sha256(question_id.encode("utf-8")).hexdigest()[:12]
    return directory / f"{index:04d}-{digest}.json"


def beam_run_identity(
    dataset: Path, client: AmlClient, *, limit: int | None, samples: set[str] | None,
    max_questions: int | None,
) -> dict[str, Any]:
    file_hash = hashlib.sha256()
    with dataset.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            file_hash.update(block)
    return {
        "dataset": str(dataset.resolve()),
        "dataset_sha256": file_hash.hexdigest(),
        "top_k": client.top_k,
        "limit": limit,
        "samples": sorted(samples) if samples else None,
        "max_questions": max_questions,
    }


def beam_hit_evidence(hit: dict[str, Any], rank: int, source_ids_by_message: dict[str, str], required: set[str]) -> dict[str, Any]:
    metadata = hit.get("metadata") if isinstance(hit.get("metadata"), dict) else {}
    candidates = (hit.get("id"), metadata.get("parentMessageId"), metadata.get("messageId"), metadata.get("rawMessageId"))
    source_ids = list(dict.fromkeys(source_ids_by_message[value] for value in candidates if isinstance(value, str) and value in source_ids_by_message))
    content = str(hit.get("content", ""))
    # Preview the actual historical text, not the repeated core order guidance.
    # The hash below still identifies the complete content seen by the model.
    preview = content
    if content.startswith("[Message order guidance]\n"):
        _, marker, excerpt = content.partition("[Original excerpt]\n")
        if marker:
            preview = excerpt
    matched_spans = []
    for span in metadata.get("matchedSpans") or []:
        if not isinstance(span, dict) or not isinstance(span.get("content"), str):
            continue
        span_content = span["content"]
        matched_spans.append({
            "source_chunk_ids": span.get("sourceChunkIds") or ([span["sourceChunkId"]] if isinstance(span.get("sourceChunkId"), str) else []),
            "start_position": span.get("startPosition"),
            "end_position": span.get("endPosition"),
            "channels": span.get("channels", []),
            "content_sha256": hashlib.sha256(span_content.encode("utf-8")).hexdigest(),
            "content_excerpt": " ".join(span_content.split())[:240],
        })
    return {
        "rank": rank,
        "id": hit.get("id"),
        "score": hit.get("score", hit.get("similarity")),
        "content_sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        "content_excerpt": " ".join(preview.split())[:240],
        "source_turn_ids": source_ids,
        "matched_source_turn_ids": [value for value in source_ids if value in required],
        "matched_spans": matched_spans,
        "matched_spans_truncated": metadata.get("matchedSpansTruncated", 0),
        "vector_scan_underfilled": metadata.get("vectorScanUnderfilled", False),
        "vector_search_fallback": metadata.get("vectorSearchFallback"),
    }


def beam_source_ids(entry: dict[str, Any], dataset: Path) -> dict[str, str]:
    user_id = scope_id("beam", dataset, str(entry["entry_id"]))
    source_ids: dict[str, str] = {}
    offset = 0
    for chunk_index, chunk in enumerate(beam_add_chunks(beam_messages(entry.get("chat") or []))):
        request_id = f"{user_id}:chunk:{chunk_index}"
        for index in range(len(chunk)):
            source_id = (entry.get("chat") or [])[offset + index].get("source_id")
            if source_id is not None:
                source_ids[f"aml:{request_id}:{index}"] = str(source_id)
        offset += len(chunk)
    return source_ids


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
        # CL-bench-Life encodes 163 tasks as one user message whose historical
        # context and final task are separated by ``<|TASK|>``. Treating that
        # whole message as the query leaves nothing to ingest or retrieve.
        if len(source_messages) == 1:
            inline_task = split_clbench_inline_task(question)
            if inline_task:
                context, question = inline_task
                context_messages = [{"role": source_messages[0].get("role", "user"), "content": context}]
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
    client: AmlClient,
    *,
    limit: int | None,
    samples: set[str] | None,
    max_questions: int | None,
    skip_ingest: bool,
    resume_message_ids: set[str] | None = None,
    output_dir: Path | None = None,
) -> list[dict[str, Any]]:
    payload = read_json(dataset)
    conversations = payload.get("conversations", []) if isinstance(payload, dict) else payload
    if samples:
        conversations = [entry for entry in conversations if str(entry.get("entry_id")) in samples]
    if limit:
        conversations = conversations[:limit]

    if output_dir is None:
        raise ValueError("BEAM retrieval requires an output directory for durable checkpoints")
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_dir = output_dir / "retrieval-checkpoints"
    state_path = output_dir / "retrieval-state.json"
    identity = beam_run_identity(dataset, client, limit=limit, samples=samples, max_questions=max_questions)

    questions: list[tuple[dict[str, Any], dict[str, Any], str]] = []
    question_ids: set[str] = set()
    for entry in conversations:
        selected_questions = entry.get("probing_questions") or []
        if max_questions:
            selected_questions = selected_questions[:max_questions]
        for index, question in enumerate(selected_questions):
            question_id = str(question.get("question_id") or f"{entry['entry_id']}_q{index}")
            if question_id in question_ids:
                raise ValueError(f"duplicate BEAM question ID: {question_id}")
            question_ids.add(question_id)
            questions.append((entry, question, question_id))

    completed_requests = (
        completed_beam_add_requests(conversations, dataset, resume_message_ids)
        if resume_message_ids is not None else set()
    )
    if state_path.exists():
        if resume_message_ids is None:
            raise ValueError("BEAM retrieval state already exists; use --resume-db or a new output tag")
        if read_json(state_path) != identity:
            raise ValueError("BEAM retrieval state does not match dataset, selection, or top_k")
    else:
        if (output_dir / "input.jsonl").exists() or (output_dir / "answers.jsonl").exists() or (output_dir / "judged.jsonl").exists() or checkpoint_dir.exists():
            raise ValueError("BEAM output already exists without matching retrieval state; use a new tag")
        write_json_atomic(state_path, identity)
    checkpoint_dir.mkdir(exist_ok=True)
    if resume_message_ids is not None:
        print(f"[aml-local] resuming: {len(completed_requests)} committed Add batches preserved", flush=True)

    total_batches = sum(len(beam_add_chunks(beam_messages(entry.get("chat") or []))) for entry in conversations)
    existing_checkpoints = list(checkpoint_dir.glob("*.json"))
    if existing_checkpoints and len(completed_requests) != total_batches:
        raise ValueError("BEAM question checkpoints exist but the database is missing Add batches")
    print(f"[aml-local] Add progress: {len(completed_requests)}/{total_batches} batches; Search progress: {len(existing_checkpoints)}/{len(questions)} questions", flush=True)

    add_completed = len(completed_requests)
    last_progress = time.monotonic()
    for entry in conversations:
        entry_id = str(entry["entry_id"])
        user_id = scope_id("beam", dataset, entry_id)
        messages = beam_messages(entry.get("chat") or [])
        if not skip_ingest:
            for chunk_index, chunk in enumerate(beam_add_chunks(messages)):
                request_id = f"{user_id}:chunk:{chunk_index}"
                if request_id not in completed_requests:
                    client.add(request_id, user_id, entry_id, chunk)
                    add_completed += 1
                    now = time.monotonic()
                    if add_completed == total_batches or add_completed % 100 == 0 or now - last_progress >= 15:
                        print(f"[aml-local] Add {add_completed}/{total_batches} batches", flush=True)
                        last_progress = now

    records: list[dict[str, Any]] = []
    traces: list[dict[str, Any]] = []
    source_maps: dict[str, dict[str, str]] = {}
    for index, (entry, question, question_id) in enumerate(questions):
        checkpoint = beam_checkpoint_path(checkpoint_dir, index, question_id)
        resumed = checkpoint.exists()
        if resumed:
            saved = read_json(checkpoint)
            if saved.get("record", {}).get("id") != question_id or saved.get("trace", {}).get("question_id") != question_id:
                raise ValueError(f"invalid BEAM question checkpoint: {checkpoint}")
            record, trace = saved["record"], saved["trace"]
        else:
            entry_id = str(entry["entry_id"])
            user_id = scope_id("beam", dataset, entry_id)
            query = str(question.get("question", ""))
            started = time.monotonic()
            hits, local_diagnostics = client.search_with_diagnostics(user_id, query)
            elapsed_ms = round((time.monotonic() - started) * 1000)
            retrieval = local_diagnostics["retrieval"]
            if entry_id not in source_maps:
                source_maps[entry_id] = beam_source_ids(entry, dataset)
            source_ids_by_message = source_maps[entry_id]
            source = question.get("source") or {}
            required_ids = {str(value) for value in source.get("source_chat_ids", [])}
            available_ids = set(source_ids_by_message.values())
            channels = retrieval.get("channels") or {}
            channel_hits = {
                name: [beam_hit_evidence(hit, rank, source_ids_by_message, required_ids) for rank, hit in enumerate(channels.get(core_name) or [], 1)]
                for name, core_name in (("keyword", "lexical"), ("semantic", "semantic"), ("planner", "planner"), ("hybrid", "hybrid"), ("entity", "entity"))
            }
            channel_ids = {name: {hit["id"] for hit in values} for name, values in channel_hits.items()}
            before = [beam_hit_evidence(hit, rank, source_ids_by_message, required_ids) for rank, hit in enumerate(retrieval["fusedBeforeRerank"], 1)]
            after = [beam_hit_evidence(hit, rank, source_ids_by_message, required_ids) for rank, hit in enumerate(retrieval["final"], 1)]
            for hit in before + after:
                hit["retrieval_channels"] = [name for name, ids in channel_ids.items() if hit["id"] in ids]
            matched_ids = {source_id for hit in after for source_id in hit["matched_source_turn_ids"]}
            mapped_final_hits = sum(bool(hit["source_turn_ids"]) for hit in after)
            channel_summary = {}
            for name, values in channel_hits.items():
                source_matches = {source_id for hit in values for source_id in hit["matched_source_turn_ids"]}
                channel_summary[name] = {
                    "candidate_count": len(values),
                    "final_hit_count": sum(name in hit["retrieval_channels"] for hit in after),
                    "mapped_candidate_hits": sum(bool(hit["source_turn_ids"]) for hit in values),
                    "matched_source_turn_ids": sorted(source_matches),
                    "source_recall_at_candidate_k": len(source_matches) / len(required_ids) if required_ids and (not values or any(hit["source_turn_ids"] for hit in values)) else None,
                }
            record = {
                "id": question_id,
                "question": query,
                "category": question.get("category"),
                "retrieved_context": hit_texts(hits),
                "rubric_nuggets": question.get("atoms") or question.get("rubrics") or [],
                "scale": entry.get("scale") or (payload.get("scale") if isinstance(payload, dict) else None),
            }
            trace = {
                "question_id": question_id,
                "entry_id": entry_id,
                "user_id": user_id,
                "query": query,
                "top_k": client.top_k,
                "latency_ms": elapsed_ms,
                "candidate_k": retrieval.get("candidateLimit"),
                "candidate_counts": retrieval.get("candidateCounts"),
                "channels": channel_hits,
                "channel_summary": channel_summary,
                "before_rerank": before,
                "reranker": retrieval["reranker"],
                "reasoning": local_diagnostics.get("reasoning"),
                "after_rerank": after,
                "search_response": hits,
                "warnings": local_diagnostics.get("warnings", []),
                "required_source_turn_ids": sorted(required_ids),
                "available_required_source_turn_ids": sorted(required_ids & available_ids),
                "missing_required_source_turn_ids": sorted(required_ids - available_ids),
                "retrieved_source_turn_ids": sorted(matched_ids),
                "mapped_final_hits": mapped_final_hits,
                "source_recall_at_k": len(matched_ids) / len(required_ids) if required_ids and (mapped_final_hits or not hits) else None,
            }
            write_json_atomic(checkpoint, {"record": record, "trace": trace})
        records.append(record)
        traces.append(trace)
        print(f"[aml-local] Search {index + 1}/{len(questions)} questions ({'resumed' if resumed else 'done'})", flush=True)
    write_jsonl(output_dir / "retrieval-traces.jsonl", traces)
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
    resume_message_ids: set[str] | None = None,
) -> Path:
    runner_options: dict[str, Any] = {
        "limit": limit,
        "samples": samples,
        "max_questions": max_questions,
        "skip_ingest": skip_ingest,
    }
    if benchmark == "beam":
        runner_options["resume_message_ids"] = resume_message_ids
        runner_options["output_dir"] = out_dir / OUTPUT_NAMES[benchmark]
    records = RUNNERS[benchmark](dataset, client, **runner_options)
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
    parser.add_argument("--resume-db", type=Path, help="BEAM only: reuse committed Add batches in this SQLite database")
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
    if reasoning not in {"none", "rewrite", "iterative", "union"}:
        parameter_errors.append("AML_REASONING_STRATEGY must be none, rewrite, iterative, or union")
        reasoning = "none"
    try:
        top_k = int(os.environ.get("AML_TOP_K", "12" if args.benchmark == "beam" else "10"))
    except ValueError:
        parameter_errors.append("AML_TOP_K must be an integer")
        top_k = 12 if args.benchmark == "beam" else 10
    if top_k < 1:
        parameter_errors.append("AML_TOP_K must be at least 1")
        top_k = 12 if args.benchmark == "beam" else 10
    if args.benchmark == "beam" and top_k != 12:
        parameter_errors.append("BEAM local run is configured for top_k=12")

    dataset = default_dataset(args.benchmark, args.dataset)
    out_dir = Path(os.environ.get("AML_OUT_DIR", DEFAULT_OUT_DIR)).resolve()
    resume_message_ids: set[str] | None = None
    if args.resume_db is not None:
        if args.benchmark != "beam" or args.skip_ingest:
            parameter_errors.append("--resume-db requires BEAM with Add enabled")
        elif not args.resume_db.is_file():
            parameter_errors.append(f"BEAM resume database is missing: {args.resume_db}")
        else:
            try:
                resume_message_ids = load_beam_resume_ids(args.resume_db)
                if not resume_message_ids:
                    parameter_errors.append("BEAM resume database contains no committed AML messages")
            except sqlite3.Error as exc:
                parameter_errors.append(f"BEAM resume database cannot be read: {exc}")
    client_type = AmlClient if args.benchmark == "beam" else OpenContextClient
    client = client_type(
        os.environ.get("AML_ADAPTER_URL", "http://127.0.0.1:7422") if args.benchmark == "beam" else os.environ.get("OPENCONTEXT_URL", "http://127.0.0.1:7421"),
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
        resume_message_ids=resume_message_ids,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
