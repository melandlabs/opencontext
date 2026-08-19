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

Auth: set AML_SYSTEM_KEY to require `Authorization: Bearer <key>` (or
`X-Api-Key: <key>`) on /add and /search. Leave unset for local testing.

Usage:
  set OPENCONTEXT_URL=http://127.0.0.1:7421  (optional, default shown)
  set AML_SYSTEM_KEY=...                     (optional; required in production)
  set AML_ADAPTER_PORT=7422                  (optional, default 7422)
  python serve.py
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OPENCONTEXT_URL = os.environ.get("OPENCONTEXT_URL", "http://127.0.0.1:7421").rstrip("/")
AML_SYSTEM_KEY = os.environ.get("AML_SYSTEM_KEY", "")
PORT = int(os.environ.get("AML_ADAPTER_PORT", "7422"))


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
    if not ms:
        return None
    try:
        return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat()
    except Exception:
        return None


def handle_add(body: dict) -> dict:
    request_id = str(body.get("request_id") or "").strip()
    user_id = str(body.get("user_id") or "").strip()
    session_id = str(body.get("session_id") or "").strip()
    messages = body.get("messages") or []
    if not request_id or not user_id or not session_id or not isinstance(messages, list) or not messages:
        raise ValueError("request_id, user_id, session_id and non-empty messages[] are required")

    now_ms = int(time.time() * 1000)
    oc_messages = []
    for i, m in enumerate(messages):
        content = m.get("content")
        if content is None:
            raise ValueError(f"messages[{i}].content is required")
        ts = m.get("timestamp")
        oc_messages.append(
            {
                # deterministic id -> platform retries stay idempotent
                "messageId": f"aml:{request_id}:{i}",
                "userId": user_id,
                "platform": "aml",
                "botId": "aml-adapter",
                "sessionId": session_id,
                "role": m.get("role", "user"),
                "timestamp": int(ts) if ts else now_ms,
                "content": str(content),
                "createdAt": now_ms,
            }
        )
    # embedOnInsert blocks until embeddings are stored, so Search right after
    # Add sees the memories (contract: return 200 only once searchable).
    oc_post("/v1/raw-messages", {"userId": user_id, "messages": oc_messages, "embedOnInsert": True})
    return {"success": True, "request_id": request_id, "user_id": user_id, "session_id": session_id}


def handle_search(body: dict) -> dict:
    query = str(body.get("query") or "").strip()
    user_id = str(body.get("user_id") or "").strip()
    top_k = body.get("top_k")
    if not query or not user_id or not isinstance(top_k, int):
        raise ValueError("query, user_id and integer top_k are required")

    res = oc_post(
        "/v1/search",
        {"userId": user_id, "query": query, "limit": top_k, "sources": ["memory"]},
        timeout=120,
    )
    data = []
    for i, hit in enumerate(res.get("results", [])):
        meta = hit.get("metadata") or {}
        item = {
            "id": str(hit.get("id") or hit.get("messageId") or f"mem_{i}"),
            "content": str(hit.get("content", "")),
        }
        sim = hit.get("similarity", hit.get("score"))
        if sim is not None:
            item["score"] = float(sim)
        created = iso_from_ms(meta.get("timestamp")) or iso_from_ms(meta.get("createdAt"))
        if created:
            item["created_at"] = created
        data.append(item)
    return {"data": data}


class Handler(BaseHTTPRequestHandler):
    server_version = "OpenContextAMLAdapter/0.1"

    def log_message(self, fmt, *args):  # keep stdout clean; errors surface via responses
        pass

    def _authorized(self) -> bool:
        if not AML_SYSTEM_KEY:
            return True
        bearer = self.headers.get("Authorization", "")
        api_key = self.headers.get("X-Api-Key", "")
        return bearer == f"Bearer {AML_SYSTEM_KEY}" or api_key == AML_SYSTEM_KEY

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/health":
            self._send(200, {"ok": True, "opencontext": OPENCONTEXT_URL})
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
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._send(400, {"error": "invalid JSON body"})
            return
        try:
            result = handle_add(body) if path == "/add" else handle_search(body)
            self._send(200, result)
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except urllib.error.URLError as e:
            self._send(502, {"error": f"opencontext daemon unreachable: {e}"})
        except Exception as e:  # noqa: BLE001 - surface upstream failures as 500
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    print(f"[aml-adapter] listening on :{PORT}, forwarding to {OPENCONTEXT_URL}, auth={'on' if AML_SYSTEM_KEY else 'off'}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
