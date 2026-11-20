"""Pre-deployment gate checks for the OpenContext AML submission.

The AML platform scores the *system*, not the code: a deployment with the
reranker switched off, an index written by a different embedding model, or a
broken Add -> Search round trip scores zero no matter how good the
retrieval code is. These checks turn those silent failures into a loud,
non-zero exit code *before* the evaluation window opens.

They are deliberately separate from the adapter's `/health` endpoint: health
is liveness (the process answers), the gate is readiness (the pipeline is
actually wired end to end).

Usage:
  python gate_check.py                       # adapter on :7422, daemon on :7421
  python gate_check.py --adapter-url https://memory.example.com --daemon-url http://127.0.0.1:7421
  python gate_check.py --allow-no-reranker   # ablation run: reranker off on purpose
  python gate_check.py --json                # machine-readable report

Exit codes: 0 = all gates passed, 1 = at least one gate failed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

DEFAULT_ADAPTER_URL = os.environ.get("AML_ADAPTER_URL", "http://127.0.0.1:7422").rstrip("/")
DEFAULT_DAEMON_URL = os.environ.get("OPENCONTEXT_URL", "http://127.0.0.1:7421").rstrip("/")
# The rendering the answer model reads. A hit that lost its date is a hit the
# judge cannot score on a time-granularity question.
EVIDENCE_PREFIX = re.compile(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] (user|assistant): ")


class GateFailure(Exception):
    """A gate that could not be evaluated at all (bad response shape)."""


class Checker:
    def __init__(
        self,
        adapter_url: str,
        daemon_url: str,
        timeout: int,
        allow_no_reranker: bool,
        semantic_timeout: int = 60,
    ) -> None:
        self.adapter_url = adapter_url
        self.daemon_url = daemon_url
        self.timeout = timeout
        self.allow_no_reranker = allow_no_reranker
        # How long to wait for the first embedding to land before calling the
        # semantic channel degraded.
        self.semantic_timeout = semantic_timeout
        self.system_key = os.environ.get("AML_SYSTEM_KEY", "").strip()
        self.results: list[dict] = []
        # Injectable so the tests do not have to wait for the retry backoff.
        self.sleep = time.sleep

    # ── plumbing ────────────────────────────────────────────────────────────
    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.system_key:
            headers["X-Api-Key"] = self.system_key
        return headers

    def request(self, method: str, url: str, payload: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
                status = response.status
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            status = error.code
        try:
            parsed = json.loads(body) if body else {}
        except json.JSONDecodeError:
            parsed = {"_raw": body[:400]}
        return status, parsed if isinstance(parsed, dict) else {"_raw": parsed}

    def adapter(self, method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
        return self.request(method, self.adapter_url + path, payload)

    def daemon(self, method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
        return self.request(method, self.daemon_url + path, payload)

    def gate(self, name: str, ok: bool, detail: str) -> bool:
        self.results.append({"gate": name, "ok": bool(ok), "detail": detail})
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")
        return bool(ok)

    # ── gates ───────────────────────────────────────────────────────────────
    def check_adapter_health(self) -> None:
        status, body = self.adapter("GET", "/health")
        if status != 200:
            raise GateFailure(f"adapter /health returned {status}: {body}")
        if body.get("ok") is not True:
            raise GateFailure(f"adapter /health is not ok: {body}")
        self.gate("adapter_health", True, f"adapter answers on {self.adapter_url}")

    def check_daemon_retrieval(self) -> dict:
        status, body = self.daemon("GET", "/health")
        if status != 200:
            raise GateFailure(f"daemon /health returned {status}: {body}")
        retrieval = body.get("retrieval")
        if not isinstance(retrieval, dict):
            raise GateFailure("daemon /health carries no retrieval status — the daemon is not the expected build")
        return retrieval

    def check_semantic(self, retrieval: dict) -> None:
        provider = retrieval.get("embeddingProvider")
        model = retrieval.get("embeddingModel")
        dimensions = retrieval.get("embeddingDimensions")
        self.gate(
            "embedding_wired",
            bool(provider and model),
            f"provider={provider} model={model} dimensions={dimensions}",
        )
        # The embedding of a newly added chunk lands asynchronously, so the
        # index fingerprint is only meaningful *after* a message was added.
        # The round trip runs first for that reason; here we wait for the
        # vectors to show up instead of failing a healthy cold deployment.
        deadline = time.monotonic() + self.semantic_timeout
        attempts = 0
        max_attempts = max(1, self.semantic_timeout)
        latest = retrieval
        model_mismatch = False
        dimension_mismatch = False
        indexed_models: list[str] = []
        indexed_dims: list[int] = []
        while True:
            indexed_models = latest.get("indexedEmbeddingModels") or []
            indexed_dims = latest.get("indexedDimensions") or []
            # The daemon only knows its own vector width once it produced a
            # vector, so the width is re-read on every poll.
            current_model = latest.get("embeddingModel") or model
            current_dimensions = latest.get("embeddingDimensions")
            if current_dimensions is None:
                current_dimensions = dimensions
            model_mismatch = bool(indexed_models) and not all(item == current_model for item in indexed_models)
            dimension_mismatch = bool(indexed_dims) and current_dimensions is not None and not all(
                item == current_dimensions for item in indexed_dims
            )
            ready = latest.get("semanticReady") is True and not model_mismatch and not dimension_mismatch
            if ready or attempts >= max_attempts or time.monotonic() >= deadline:
                break
            attempts += 1
            self.sleep(1.0)
            try:
                latest = self.check_daemon_retrieval()
            except GateFailure:
                break
        model = current_model
        dimensions = current_dimensions

        if indexed_models:
            self.gate(
                "embedding_model_matches_index",
                not model_mismatch,
                f"index holds {indexed_models}, daemon runs {model}"
                + ("" if not model_mismatch else " — vectors from a different model are not comparable"),
            )
        else:
            self.gate("embedding_model_matches_index", True, "index has no embedded rows yet (empty volume)")
        if dimensions is not None and indexed_dims:
            self.gate(
                "embedding_dimensions_match_index",
                not dimension_mismatch,
                f"index holds dimensions {indexed_dims}, daemon produces {dimensions}",
            )
        reason = latest.get("semanticDegradedReason")
        # The daemon reports its own readiness, but an older build does not
        # know about the model fingerprint — so the gate decides on the
        # fingerprint too, not only on the daemon's claim.
        ready = latest.get("semanticReady") is True and not model_mismatch and not dimension_mismatch
        self.gate(
            "semantic_ready",
            ready,
            f"semanticReady={latest.get('semanticReady')} degradedReason={reason}"
            + ("" if ready else " (waited up to %ds for the first embedding)" % self.semantic_timeout),
        )

    def check_lexical(self, retrieval: dict) -> None:
        self.gate(
            "lexical_ready",
            retrieval.get("lexicalReady") is True,
            f"lexicalReady={retrieval.get('lexicalReady')} (FTS5 index present)",
        )

    def check_reranker(self, retrieval: dict) -> None:
        ready = retrieval.get("rerankerReady") is True
        detail = f"rerankerReady={ready} provider={retrieval.get('rerankerProvider')} model={retrieval.get('rerankerModel')}"
        if not ready and self.allow_no_reranker:
            self.gate("reranker_ready", True, detail + " (allowed by --allow-no-reranker)")
            return
        self.gate("reranker_ready", ready, detail)

    def check_round_trip(self) -> None:
        """Add a canary and find it again — the whole pipeline, end to end."""
        token = f"zqxkcanary{uuid.uuid4().hex[:8]}"
        user_id = f"gate-check-{token}"
        session_id = f"gate-session-{token}"
        # A fixed date so the rendered evidence prefix is deterministic.
        timestamp = 1_767_225_600_000  # 2026-01-01T00:00:00Z
        status, body = self.adapter(
            "POST",
            "/add",
            {
                "request_id": f"gate-{token}",
                "user_id": user_id,
                "session_id": session_id,
                "messages": [
                    {"role": "user", "content": f"The access code for the observatory is {token}.", "timestamp": timestamp}
                ],
            },
        )
        if status != 200 or body.get("success") is not True:
            raise GateFailure(f"Add failed: status={status} body={body}")

        # The lexical channel has to see it right away — the platform answers
        # questions as soon as the Add returned.
        found = None
        for attempt in range(5):
            status, body = self.adapter(
                "POST", "/search", {"query": token, "user_id": user_id, "top_k": 10}
            )
            if status != 200:
                raise GateFailure(f"Search failed: status={status} body={body}")
            for item in body.get("data") or []:
                if token in (item.get("content") or ""):
                    found = item
                    break
            if found is not None:
                break
            self.sleep(0.4 * (attempt + 1))
        if found is None:
            self.gate("round_trip_add_search", False, f"the canary {token} was not returned by Search")
            return
        self.gate("round_trip_add_search", True, f"canary {token} returned as id={found.get('id')}")

        content = found.get("content") or ""
        match = EVIDENCE_PREFIX.match(content)
        self.gate(
            "evidence_is_dated_and_attributed",
            bool(match),
            f"content starts with {content[:48]!r}"
            + ("" if match else " — expected a '[YYYY-MM-DD HH:MM] speaker: ' prefix"),
        )
        self.gate(
            "evidence_has_no_boilerplate",
            "Message order guidance" not in content,
            "the rendered hit carries no instruction boilerplate",
        )

        # Isolation: another user must not see the canary.
        status, body = self.adapter(
            "POST", "/search", {"query": token, "user_id": f"other-{token}", "top_k": 10}
        )
        leaked = any(token in (item.get("content") or "") for item in (body.get("data") or []))
        self.gate("user_isolation", not leaked, "a different user_id cannot see another user's memory")

    def check_top_k(self) -> None:
        status, body = self.adapter(
            "POST", "/search", {"query": "memory", "user_id": "gate-check-topk", "top_k": 100}
        )
        if status != 200:
            self.gate("top_k_100", False, f"Search with top_k=100 returned {status}: {body}")
            return
        data = body.get("data") or []
        self.gate("top_k_100", len(data) <= 100, f"top_k=100 accepted, {len(data)} results")

        status, body = self.adapter(
            "POST", "/search", {"query": "memory", "user_id": "gate-check-topk", "top_k": 1}
        )
        data = body.get("data") or []
        self.gate(
            "top_k_respected",
            status == 200 and len(data) <= 1,
            f"top_k=1 returned {len(data)} results",
        )

    def check_concurrency(self, concurrency: int) -> None:
        errors: list[str] = []
        statuses: list[int] = []
        lock = threading.Lock()

        def worker(index: int) -> None:
            status, body = self.adapter(
                "POST",
                "/search",
                {"query": f"gate concurrency probe {index}", "user_id": "gate-check-concurrency", "top_k": 12},
            )
            with lock:
                statuses.append(status)
                if status >= 500:
                    errors.append(f"status={status} body={body}")

        threads = [threading.Thread(target=worker, args=(index,)) for index in range(concurrency)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.gate(
            "no_5xx_under_concurrency",
            not errors and statuses and all(status == 200 for status in statuses),
            f"{len(statuses)} concurrent searches, statuses={sorted(set(statuses))}"
            + (f" errors={errors[:3]}" if errors else ""),
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Pre-deployment gate checks for the OpenContext AML submission")
    parser.add_argument("--adapter-url", default=DEFAULT_ADAPTER_URL)
    parser.add_argument("--daemon-url", default=DEFAULT_DAEMON_URL)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument(
        "--semantic-timeout",
        type=int,
        default=60,
        help="seconds to wait for the first embedding to land before calling the semantic channel degraded",
    )
    parser.add_argument(
        "--allow-no-reranker",
        action="store_true",
        help="do not fail when the reranker is off (ablation runs only)",
    )
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    args = parser.parse_args(argv)

    checker = Checker(
        args.adapter_url,
        args.daemon_url,
        args.timeout,
        args.allow_no_reranker,
        args.semantic_timeout,
    )
    failed = False
    try:
        checker.check_adapter_health()
        retrieval = checker.check_daemon_retrieval()
        checker.check_lexical(retrieval)
        checker.check_reranker(retrieval)
        # The round trip adds a message, so the index has a chunk to embed
        # before the semantic gates look at the fingerprint.
        checker.check_round_trip()
        checker.check_semantic(retrieval)
        checker.check_top_k()
        checker.check_concurrency(args.concurrency)
    except GateFailure as error:
        checker.gate("gate_check_completed", False, str(error))
        failed = True
    except Exception as error:  # noqa: BLE001 - report, do not crash the deployment
        checker.gate("gate_check_completed", False, f"{type(error).__name__}: {error}")
        failed = True

    failures = [result for result in checker.results if not result["ok"]]
    failed = failed or bool(failures)
    if args.json:
        print(json.dumps({"ok": not failed, "results": checker.results}, ensure_ascii=False, indent=2))
    else:
        print()
        print(f"{len(checker.results) - len(failures)}/{len(checker.results)} gates passed")
        if failures:
            print("FAILED gates:")
            for result in failures:
                print(f"  - {result['gate']}: {result['detail']}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
