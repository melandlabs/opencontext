"""AML Add/Search adapter for the OpenContext memory daemon.

Exposes the Agent Memory Leaderboard (agentmemories.ai) hosted-integration
contract and forwards every operation to a running OpenContext daemon
(`opencontext http`, default http://127.0.0.1:7421):

  POST /add     {request_id, messages[{role, content, timestamp?}], user_id, session_id}
                -> OpenContext POST /v1/raw-messages (embedOnInsert, synchronous)
                <- {success: true, request_id, user_id, session_id}

  POST /search  {query, options?, user_id, top_k}
                -> OpenContext POST /v1/search (scope = user_id)
                <- {data: [{id, content, score, created_at}]}  (relevance-ordered)

  GET  /health  <- {"ok": true}

Isolation: the AML `user_id` is passed through verbatim as the OpenContext
userId, so every eval sample stays isolated exactly as the contract requires.
Idempotency: the OpenContext messageId is derived from `request_id`, so
platform retries of the same Add request do not create duplicates.

Auth (two distinct keys — see the AML participation guide):
  * Memory System Key — you generate it and share it with the platform.
    Set AML_SYSTEM_KEY; accepted as `Authorization: Token <key>`,
    `Authorization: Bearer <key>` or
    `X-Api-Key: <key>` on /add and /search.
  * Eval Key — the platform issues it to you when your evaluation is
    approved. Set AML_EVAL_KEY; accepted as `X-Eval-Key: <key>` on
    /add and /search. If the platform's actual Eval Key header name
    differs once issued, adjust `EVAL_KEY_HEADERS` below.
  Leave both unset for local testing (auth disabled).

Retry semantics (per the AML API guide): the platform may retry Add on
408/409/425/429/5xx and Search on 408/425/429/5xx. Client errors (400)
are never retried, so request validation must fail fast with 4xx;
upstream daemon failures surface as 502/503 with a Retry-After header.
Add is idempotent (messageId derived from request_id), so platform
retries of the same Add never create duplicate memories.

Usage:
  set OPENCONTEXT_URL=http://127.0.0.1:7421  (optional, default shown)
  set AML_SYSTEM_KEY=...                     (optional; required in production)
  set AML_EVAL_KEY=...                       (optional; platform-issued)
  set AML_ADAPTER_PORT=7422                  (optional, default 7422)
  python serve.py
"""
from __future__ import annotations

import json
import math
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OPENCONTEXT_URL = os.environ.get("OPENCONTEXT_URL", "http://127.0.0.1:7421").rstrip("/")
AML_SYSTEM_KEY = os.environ.get("AML_SYSTEM_KEY", "")
AML_EVAL_KEY = os.environ.get("AML_EVAL_KEY", "")
# Header names carrying the platform-issued Eval Key. Adjust to match the
# real header once the platform issues your Eval Key.
EVAL_KEY_HEADERS = ("X-Eval-Key", "X-Aml-Eval-Key")
PORT = int(os.environ.get("AML_ADAPTER_PORT", "7422"))
# Seconds advertised via Retry-After on transient (retriable) failures.
RETRY_AFTER_SECONDS = os.environ.get("AML_RETRY_AFTER", "5")


def oc_post(path: str, payload: dict, timeout: int = 600) -> dict:
    req = urllib.request.Request(
        OPENCONTEXT_URL + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def iso_from_ms(ms: int | None) -> str | None:
    if ms is None:
        return None
    try:
        value = int(ms)
        return datetime.fromtimestamp(value if abs(value) < 100_000_000_000 else value / 1000, tz=timezone.utc).isoformat()
    except Exception:
        return None


def handle_add(body: dict) -> dict:
    if not isinstance(body, dict):
        raise ValueError("Add body must be an object")
    request_id = body.get("request_id")
    user_id = body.get("user_id")
    session_id = body.get("session_id")
    messages = body.get("messages")
    if any(not isinstance(value, str) or not value.strip() for value in (request_id, user_id, session_id)) or not isinstance(messages, list) or not messages:
        raise ValueError("request_id, user_id, session_id and non-empty messages[] are required")

    now_seconds = int(time.time())
    oc_messages = []
    for i, m in enumerate(messages):
        if not isinstance(m, dict):
            raise ValueError(f"messages[{i}] must be an object")
        content = m.get("content")
        role = m.get("role")
        if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
            raise ValueError(f"messages[{i}] requires user/assistant role and non-empty string content")
        ts = m.get("timestamp")
        if ts is not None and (isinstance(ts, bool) or not isinstance(ts, int)):
            raise ValueError(f"messages[{i}].timestamp must be Unix milliseconds")
        oc_message = {
                # deterministic id -> platform retries stay idempotent
                "messageId": f"aml:{request_id}:{i}",
                "userId": user_id,
                "platform": "aml",
                "botId": "aml-adapter",
                "metadata": {"sessionId": session_id, "role": role},
                "content": content,
                "createdAt": now_seconds,
            }
        if ts is not None:
            oc_message["timestamp"] = ts
        oc_messages.append(oc_message)
    # embedOnInsert blocks until embeddings are stored, so Search right after
    # Add sees the memories (contract: return 200 only once searchable).
    result = oc_post("/v1/raw-messages", {"userId": user_id, "messages": oc_messages, "embedOnInsert": True}, timeout=1800)
    if result.get("ok") is not True or result.get("count") != len(oc_messages) or result.get("warnings"):
        raise RuntimeError("OpenContext did not confirm fully embedded Add messages")
    return {"success": True, "request_id": request_id, "user_id": user_id, "session_id": session_id}


def handle_search(body: dict, *, local_diagnostics: bool = False) -> dict:
    if not isinstance(body, dict):
        raise ValueError("Search body must be an object")
    query = body.get("query")
    user_id = body.get("user_id")
    top_k = body.get("top_k")
    if not isinstance(query, str) or not query.strip() or not isinstance(user_id, str) or not user_id.strip() or isinstance(top_k, bool) or not isinstance(top_k, int) or top_k < 1:
        raise ValueError("query, user_id and positive integer top_k are required")
    options = body.get("options")
    if options is not None and (not isinstance(options, list) or any(not isinstance(option, str) for option in options)):
        raise ValueError("options must be an array of strings when supplied")

    res = oc_post(
        "/v1/search",
        {"userId": user_id, "query": query, "limit": top_k, "sources": ["memory"],
         **({"includeRetrievalDiagnostics": True} if local_diagnostics else {})},
        timeout=1800,
    )
    data = []
    hits = res.get("results")
    if not isinstance(hits, list) or len(hits) > top_k:
        raise RuntimeError("OpenContext returned invalid or over-limit search results")
    for hit in hits:
        if not isinstance(hit, dict) or not isinstance(hit.get("id"), str) or not hit["id"] or not isinstance(hit.get("content"), str) or not hit["content"]:
            raise RuntimeError("OpenContext returned a search result without a valid id or content")
        meta = hit.get("metadata") or {}
        item = {
            "id": hit["id"],
            "content": hit["content"],
        }
        sim = meta.get("rerankerScore", hit.get("similarity", hit.get("score")))
        if isinstance(sim, (int, float)) and not isinstance(sim, bool) and math.isfinite(sim):
            item["score"] = float(sim)
        created = iso_from_ms(meta.get("timestamp")) or iso_from_ms(meta.get("createdAt"))
        if created:
            item["created_at"] = created
        data.append(item)
    response = {"data": data}
    if local_diagnostics:
        diagnostics = res.get("retrievalDiagnostics")
        if not isinstance(diagnostics, dict) or not isinstance(diagnostics.get("fusedBeforeRerank"), list) or not isinstance(diagnostics.get("reranker"), dict) or not isinstance(diagnostics.get("final"), list):
            raise RuntimeError("OpenContext did not return complete retrieval diagnostics")
        if [hit.get("id") for hit in diagnostics["final"]] != [hit.get("id") for hit in hits]:
            raise RuntimeError("OpenContext diagnostics do not match final Search order")
        response["_local_diagnostics"] = {
            "retrieval": diagnostics,
            "warnings": res.get("warnings", []),
        }
    return response


class Handler(BaseHTTPRequestHandler):
    server_version = "OpenContextAMLAdapter/0.1"

    def log_message(self, fmt, *args):  # keep stdout clean; errors surface via responses
        pass

    def _authorized(self) -> bool:
        if not AML_SYSTEM_KEY and not AML_EVAL_KEY:
            return True
        bearer = self.headers.get("Authorization", "")
        api_key = self.headers.get("X-Api-Key", "")
        if AML_SYSTEM_KEY and (bearer in (f"Bearer {AML_SYSTEM_KEY}", f"Token {AML_SYSTEM_KEY}") or api_key == AML_SYSTEM_KEY):
            return True
        if AML_EVAL_KEY and any(self.headers.get(h, "") == AML_EVAL_KEY for h in EVAL_KEY_HEADERS):
            return True
        return False

    def _send(self, code: int, payload: dict, headers: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_retriable(self, code: int, message: str) -> None:
        # 5xx is retriable per the AML retry contract; advertise backoff.
        self._send(code, {"error": message, "retriable": True}, {"Retry-After": RETRY_AFTER_SECONDS})

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/health":
            try:
                with urllib.request.urlopen(OPENCONTEXT_URL + "/health", timeout=5) as response:
                    if not 200 <= response.status < 300:
                        raise RuntimeError(f"daemon health returned {response.status}")
                    daemon_health = json.loads(response.read().decode("utf-8"))
                if daemon_health.get("ok") is not True:
                    raise RuntimeError("daemon health is not ok")
                if (daemon_health.get("retrieval") or {}).get("rerankerReady") is not True:
                    raise RuntimeError("required reranker is not ready")
                self._send(200, {"ok": True, "opencontext": OPENCONTEXT_URL, "retrieval": daemon_health.get("retrieval")})
            except Exception as error:
                self._send_retriable(503, f"opencontext daemon unavailable: {error}")
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = self.path.rstrip("/")
        if path not in ("/add", "/search"):
            self._send(404, {"error": "not found"})
            return
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        if self.headers.get("X-OpenContext-Local-Diagnostics") == "1" and self.client_address[0] not in ("127.0.0.1", "::1"):
            self._send(403, {"error": "local diagnostics require a loopback client"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._send(400, {"error": "invalid JSON body"})
            return
        try:
            result = handle_add(body) if path == "/add" else handle_search(
                body, local_diagnostics=self.headers.get("X-OpenContext-Local-Diagnostics") == "1"
            )
            self._send(200, result)
        except ValueError as e:
            # 4xx: client error, NOT retriable per the AML contract
            self._send(400, {"error": str(e), "retriable": False})
        except urllib.error.URLError as e:
            self._send_retriable(502, f"opencontext daemon unreachable: {e}")
        except Exception as e:  # noqa: BLE001 - surface upstream failures as 500
            self._send_retriable(500, str(e))


if __name__ == "__main__":
    auth = []
    if AML_SYSTEM_KEY:
        auth.append("system-key")
    if AML_EVAL_KEY:
        auth.append("eval-key")
    print(f"[aml-adapter] listening on :{PORT}, forwarding to {OPENCONTEXT_URL}, auth={'+'.join(auth) if auth else 'off'}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
