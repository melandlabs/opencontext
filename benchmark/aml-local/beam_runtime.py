"""Resumable local execution; prompts, rubric parsing and metrics stay upstream."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx

retry_sleep = asyncio.sleep


class RequestFailure(RuntimeError):
    pass


def retry_delay(error, attempt):
    delay = min(10, 2 ** attempt)
    if isinstance(error, httpx.HTTPStatusError):
        if error.response.status_code == 429:
            delay = min(60, 15 * 2 ** (attempt - 1))
        value = error.response.headers.get("Retry-After")
        if value:
            try:
                seconds = float(value)
            except ValueError:
                try:
                    seconds = (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
                except (TypeError, ValueError, OverflowError):
                    seconds = 0
            delay = max(delay, min(300, seconds))
    return delay


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def append_json(path, value):
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False) + "\n")
        handle.flush()


class BeamRuntime:
    def __init__(self, official, args):
        self.official, self.args = official, args
        self.stage = "evaluate" if hasattr(args, "answers") else "answer"
        self.output = Path(args.output)
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.errors = self.output.with_name(self.output.stem + "-errors.jsonl")
        self.status_path = self.output.with_name(self.output.stem + "-status.json")
        self.log_path = self.output.with_name(self.output.stem + "-runtime.log")
        self.requests_path = self.output.with_name(self.output.stem + "-requests.jsonl")
        self.responses_path = self.output.with_name(self.output.stem + "-responses.json")
        self.responses = (json.loads(self.responses_path.read_text(encoding="utf-8"))
                          if self.responses_path.exists() else {})
        prefix = "JUDGE" if self.stage == "evaluate" else "ANSWER"
        args.model = os.environ.get(prefix + "_MODEL", "").strip()
        args.base_url = os.environ.get(prefix + "_API_BASE", "").rstrip("/")
        args.api_key = os.environ.get(prefix + "_API_KEY", "")
        if not all((args.model, args.base_url, args.api_key)):
            raise ValueError(f"Missing {prefix}_MODEL, {prefix}_API_BASE or {prefix}_API_KEY")
        self.attempts = int(os.environ.get("AML_BEAM_REQUEST_ATTEMPTS", "3"))
        self.timeout = float(os.environ.get("AML_BEAM_REQUEST_TIMEOUT", "120"))
        self.heartbeat_seconds = float(os.environ.get("AML_BEAM_HEARTBEAT_SECONDS", "15"))
        self.ceiling = int(os.environ.get("AML_BEAM_MAX_TOKENS", "8192"))
        if min(self.attempts, self.timeout, self.heartbeat_seconds, self.ceiling) <= 0:
            raise ValueError("BEAM retry, timeout, heartbeat and token limits must be positive")
        # Keep the previously tested 14B routes scoped to that model. Other
        # models use OpenRouter routing unless an operator explicitly pins it.
        old_model = args.model.lower() == "qwen/qwen3-14b"
        self.rubric_provider = os.environ.get("AML_BEAM_JUDGE_PROVIDER", "NextBit" if old_model else "")
        self.event_provider = os.environ.get("AML_BEAM_EVENT_PROVIDER", "Alibaba" if old_model else "")
        self.state = {"stage": self.stage, "model": args.model, "status": "starting",
                      "question_id": None, "succeeded": 0, "failed_this_run": 0,
                      "missing_answers": 0, "request_count": 0}
        self.question_started = time.monotonic()

    def log(self, message):
        line = f"[{timestamp()}] [aml-local] {message}"
        print(line, flush=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        self.state["updated_at"] = timestamp()
        write_json(self.status_path, self.state)

    async def heartbeat(self):
        while True:
            await asyncio.sleep(self.heartbeat_seconds)
            self.log(f"{self.stage} {self.state['question_id']} waiting "
                     f"{int(time.monotonic() - self.question_started)}s; "
                     f"success={self.state['succeeded']}/{self.state['total']} "
                     f"failed={self.state['failed_this_run']} "
                     f"request={self.state['request_count']} attempt={self.state.get('attempt', 0)}")

    async def call_model(self, client, args, messages, max_tokens, json_mode=False):
        event = (len(messages) == 2 and messages[0].get("content") == self.official["EQUIVALENCE_SYSTEM_PROMPT"])
        payload = {"model": args.model, "messages": messages, "temperature": 0, "max_tokens": max_tokens}
        if args.base_url == "https://api.siliconflow.cn/v1" and args.model == "Qwen/Qwen3-14B":
            payload["enable_thinking"] = False
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        if "openrouter.ai" in args.base_url:
            provider = self.event_provider if event else self.rubric_provider if json_mode else ""
            if provider:
                payload["provider"] = {"order": [provider], "allow_fallbacks": False}
            if event or os.environ.get("AML_BEAM_DISABLE_REASONING", "").lower() in {"1", "true", "yes"}:
                payload["reasoning"] = {"effort": "none"}
        # Resume successful subrequests within an unfinished event-ordering
        # judgement. Reuse only the exact question, endpoint and request payload.
        cache_key = hashlib.sha256(json.dumps(
            [self.state["question_id"], args.base_url, payload],
            sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if self.stage == "evaluate" and cache_key in self.responses:
            return self.responses[cache_key]
        self.state["request_count"] += 1
        budget = max_tokens
        last_error = ""
        for attempt in range(1, self.attempts + 1):
            self.state.update(attempt=attempt, max_tokens=budget)
            audit = {"id": self.state["question_id"], "stage": self.stage, "model": args.model,
                     "kind": "event_alignment" if event else "rubric" if json_mode else "answer",
                     "attempt": attempt, "max_tokens": budget, "timestamp": timestamp()}
            truncated = False
            try:
                try:
                    response = await asyncio.wait_for(client.post(
                        args.base_url + "/chat/completions",
                        headers={"Authorization": f"Bearer {args.api_key}", "Content-Type": "application/json"},
                        json={**payload, "max_tokens": budget}), timeout=self.timeout)
                except TimeoutError:
                    raise
                except OSError as exc:
                    # TLS/socket failures can escape httpcore without being
                    # wrapped by httpx (e.g. SSL bad-record-MAC on Windows).
                    # Normalize only network I/O here; filesystem errors while
                    # saving results must remain fatal rather than be skipped.
                    raise httpx.TransportError(f"{type(exc).__name__}: {exc}") from exc
                audit["http_status"] = response.status_code
                response.raise_for_status()
                result = response.json()
                choice = result["choices"][0]
                content = choice["message"].get("content")
                audit.update(provider=result.get("provider"), response_model=result.get("model"),
                             finish_reason=choice.get("finish_reason"), usage=result.get("usage"))
                truncated = choice.get("finish_reason") == "length"
                if not isinstance(content, str) or not content.strip():
                    raise ValueError("empty completion")
                if truncated:
                    raise ValueError("completion truncated (finish_reason=length)")
                if json_mode:
                    self.official["parse_rubric_scores"](content, self.state["rubric_count"])
                if event and content.strip().strip("*.! \n").casefold() not in {"yes", "no"}:
                    raise ValueError("event alignment did not return YES or NO")
                audit["status"] = "success"
                append_json(self.requests_path, audit)
                if self.stage == "evaluate":
                    self.responses[cache_key] = content.strip()
                    write_json(self.responses_path, self.responses)
                return content.strip()
            except (httpx.HTTPError, TimeoutError, ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
                detail = f"{type(exc).__name__}: {str(exc)[:500]}"
                if isinstance(exc, httpx.HTTPStatusError):
                    detail += f"; provider_response={exc.response.text[:500]}"
                last_error = detail.replace(args.api_key, "[redacted]")
                audit.update(status="error", error=last_error)
                append_json(self.requests_path, audit)
                self.log(f"{self.stage} {self.state['question_id']} request {attempt}/{self.attempts} "
                         f"failed: {last_error}; max_tokens={budget}")
                # No outer retry loop multiplies these attempts. Growth is an
                # explicitly logged local recovery policy, not an upstream default.
                if truncated:
                    budget = min(max(self.ceiling, max_tokens), max(2048, budget * 2))
                if attempt < self.attempts:
                    delay = retry_delay(exc, attempt)
                    self.log(f"{self.stage} {self.state['question_id']} retrying in {delay:g}s")
                    await retry_sleep(delay)
        raise RequestFailure(f"request failed after {self.attempts} attempts: {last_error}")

    async def run(self):
        rows = self.official["rows"]
        items = {x["id"]: x for x in rows(self.args.input)}
        previous = rows(self.output) if self.output.exists() else []
        done = {x["id"] for x in previous}
        if not done <= items.keys():
            raise ValueError("Output contains IDs outside the input dataset")
        answers = {x["id"]: x["generated_answer"] for x in rows(self.args.answers)} if self.stage == "evaluate" else {}
        if self.stage == "evaluate" and not answers.keys() <= items.keys():
            raise ValueError("Answer IDs do not match the input dataset")
        for record in previous:
            if self.stage == "answer" and not record.get("generated_answer", "").strip():
                raise ValueError(f"Existing empty answer: {record['id']}")
            if self.stage == "answer" and record.get("answer_model", self.args.model) != self.args.model:
                raise ValueError("Existing answer model differs; choose a new output directory")
            if self.stage == "evaluate":
                if record.get("judge_model") != self.args.model:
                    raise ValueError("Existing judgement model differs; choose a new output directory")
                expected = record.get("answer_sha256")
                actual = hashlib.sha256(answers.get(record["id"], "").encode()).hexdigest()
                if expected and expected != actual:
                    raise ValueError(f"Answer changed for scored question {record['id']}")
        identity = {"input_sha256": hashlib.sha256(Path(self.args.input).read_bytes()).hexdigest(),
                    "model": self.args.model, "base_url": self.args.base_url,
                    "initial_max_tokens": getattr(self.args, "max_tokens", getattr(self.args, "judge_max_tokens", None)),
                    "rubric_provider": self.rubric_provider, "event_provider": self.event_provider,
                    "request_attempts": self.attempts, "request_timeout": self.timeout,
                    "max_tokens_ceiling": self.ceiling,
                    "disable_reasoning": os.environ.get("AML_BEAM_DISABLE_REASONING", "0")}
        config = self.output.with_name(self.output.stem + "-config.json")
        if config.exists() and json.loads(config.read_text(encoding="utf-8"))["identity"] != identity:
            raise ValueError("Execution configuration changed; choose a new output directory")
        if not config.exists():
            write_json(config, {"identity": identity, "adopted_existing_records": len(previous), "created_at": timestamp()})
        self.output.touch(exist_ok=True)
        self.state.update(total=len(items), succeeded=len(done), status="running")
        self.log(f"{self.stage} model={self.args.model}; resumed={len(done)}/{len(items)}; "
                 f"rubric_provider={self.rubric_provider or 'auto'}; event_provider={self.event_provider or 'auto'}; "
                 f"max_attempts={self.attempts}; request_timeout={self.timeout}s")
        # The upstream event matcher calls call_model internally. Replace only
        # its transport; its prompt, matching algorithm and score stay intact.
        call_globals = self.official["align_with_llm"].__globals__
        original_call = call_globals["call_model"]
        call_globals["call_model"] = self.call_model
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                for index, (ident, item) in enumerate(items.items(), 1):
                    if ident in done:
                        continue
                    self.state.update(question_id=ident, position=index, attempt=0)
                    self.question_started = time.monotonic()
                    if self.stage == "evaluate" and ident not in answers:
                        self.state["missing_answers"] += 1
                        self.log(f"evaluate {ident} skipped: no successful answer")
                        continue
                    self.log(f"{self.stage} {index}/{len(items)} starting {ident}")
                    heartbeat = asyncio.create_task(self.heartbeat())
                    try:
                        result = await self.process_item(client, ident, item, answers)
                        append_json(self.output, result)
                        done.add(ident)
                        self.state["succeeded"] = len(done)
                        self.log(f"{self.stage} {ident} saved; success={len(done)}/{len(items)}")
                    except RequestFailure as exc:
                        append_json(self.errors, {"id": ident, "stage": self.stage, "model": self.args.model,
                                                 "error": str(exc), "timestamp": timestamp()})
                        self.state["failed_this_run"] += 1
                        self.log(f"{self.stage} {ident} FAILED; recorded in {self.errors.name}; continuing")
                    finally:
                        heartbeat.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await heartbeat
        finally:
            call_globals["call_model"] = original_call
        self.state.update(status="complete" if len(done) == len(items) else "partial",
                          pending_ids=[ident for ident in items if ident not in done], question_id=None)
        if self.stage == "evaluate":
            scored = rows(self.output)
            self.state["mean_score_on_scored_questions"] = sum(r["llm_judge_score"] for r in scored) / len(scored) if scored else None
        self.log(f"{self.stage} FINISHED: {self.state['status']}; success={len(done)}/{len(items)}; "
                 f"failed_this_run={self.state['failed_this_run']}; missing_answers={self.state['missing_answers']}")
        return 0 if len(done) == len(items) else 2

    async def process_item(self, client, ident, item, answers):
        o, args = self.official, self.args
        if self.stage == "answer":
            answer = await self.call_model(client, args, [{"role": "user", "content": o["render_answer_prompt"](item)}], args.max_tokens)
            return {"id": ident, "generated_answer": answer, "answer_model": args.model}
        rubrics = o["rubric_items"](item)
        self.state["rubric_count"] = len(rubrics)
        response = await self.call_model(client, args, [{"role": "user", "content": o["render_batch_judge_prompt"](
            o["text"](item["question"]), answers[ident], rubrics)}], args.judge_max_tokens, json_mode=True)
        scores = o["parse_rubric_scores"](response, len(rubrics))
        result = {"id": ident, "question_type": item.get("question_type", item.get("category")),
                  "judge_model": args.model, "rubric_scores": [{"rubric": r, "score": s["score"], "reason": s["reason"]}
                                                             for r, s in zip(rubrics, scores)],
                  "llm_judge_score": sum(s["score"] for s in scores) / len(scores), "judge_response": response,
                  "answer_sha256": hashlib.sha256(answers[ident].encode()).hexdigest()}
        if result["question_type"] == "event_ordering":
            reference, system = await o["align_with_llm"](client, args, rubrics, answers[ident].split("\n"))
            result["event_ordering"] = o["event_ordering_metrics"](reference, system)
        return result


def main(pipeline, arguments):
    import runpy
    official = runpy.run_path(pipeline, run_name="_beam_official")
    args = official["parser"]().parse_args(arguments)
    runtime = BeamRuntime(official, args)
    try:
        return asyncio.run(runtime.run())
    except BaseException as exc:
        runtime.state["status"] = "interrupted" if isinstance(exc, KeyboardInterrupt) else "fatal"
        runtime.log(f"{runtime.stage} STOPPED: {type(exc).__name__}: {exc}")
        raise
