"""Tiny OpenAI-compatible proxy in front of the openloomi /api/native/agent
endpoint. This lets Tencent's official infer.py and eval.py talk to openloomi
through a familiar OpenAI-shaped API surface.

What it does:
- Listens on 127.0.0.1:<port>
- POST /v1/chat/completions with body { model, messages, ... } forwards to
  http://127.0.0.1:<openloomi_port>/api/native/agent with a synthesized
  prompt, then wraps the response in OpenAI Chat Completions shape.
- Only one model is exposed ("openloomi-agent") so infer.py can keep its
  --model flag.

Why we need it: openloomi's own /api/ai/v1/chat/completions routes through
the agent CLI runtime which is slow and not what infer.py expects. The
/api/native/agent endpoint already gives us a stable, scripted response
shape and matches the behavior of the older benchmark package.

Run:
    python openloomi_proxy.py --openloomi-port 3515 --port 3800

Then point infer.py at:
    --base-url http://127.0.0.1:3800/v1
"""
import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import urllib.request


def build_prompt_from_messages(messages):
    parts = []
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        if isinstance(content, list):
            content = "".join(
                b.get("text", "") for b in content if isinstance(b, dict)
            )
        if role == "system":
            parts.append(f"System: {content}")
        elif role == "user":
            parts.append(f"User: {content}")
        # assistant turns are folded into context, not the prompt
    parts.append(
        "\n\nImportant: Respond in the same language as the user's last message."
    )
    return "\n\n".join(parts)


def call_native_agent(prompt, openloomi_base, token):
    url = f"{openloomi_base}/api/native/agent"
    body = json.dumps({"prompt": prompt, "provider": "claude"}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    with urllib.request.urlopen(req, timeout=2400) as resp:
        text = resp.read().decode("utf-8")
    # /api/native/agent returns SSE-style stream or plain text or JSON.
    # 1. Try JSON first.
    try:
        data = json.loads(text)
        for key in ("text", "content", "message", "result"):
            if isinstance(data, dict) and isinstance(data.get(key), str):
                return data[key]
        if isinstance(data, str):
            return data
    except json.JSONDecodeError:
        pass
    # 2. SSE: collect `type === "text"` events.
    text_parts = []
    for line in text.split("\n"):
        trimmed = line.strip()
        if trimmed.startswith("data:") or trimmed.startswith("0:"):
            payload = trimmed[5:].strip() if trimmed.startswith("data:") else trimmed[1:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict) and parsed.get("type") == "text" and parsed.get("content"):
                text_parts.append(parsed["content"])
    if text_parts:
        return "".join(text_parts)
    # 3. Return as-is.
    return text


def _write_json_response(handler, status, body):
    """Write a JSON response without going through BaseHTTPRequestHandler
    (which encodes HTTP headers as latin-1 and breaks on non-ASCII content)."""
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    head = (
        f"HTTP/1.1 {status} OK\r\n"
        f"Content-Type: application/json; charset=utf-8\r\n"
        f"Content-Length: {len(payload)}\r\n"
        f"Connection: close\r\n"
        f"\r\n"
    ).encode("ascii")
    try:
        handler.wfile.write(head)
        handler.wfile.write(payload)
        handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, OSError):
        # Client went away — not our problem.
        pass


def _write_error(handler, status, message):
    """ASCII-safe error response (no latin-1 trap)."""
    body = {"error": {"message": message, "type": "proxy_error", "code": status}}
    _write_json_response(handler, status, body)


class ProxyHandler(BaseHTTPRequestHandler):
    openloomi_base = None
    openloomi_token = None

    # Force latin-1 → ascii for headers so non-ASCII never sneaks in.
    def log_message(self, format, *args):
        sys.stderr.write(
            "[proxy] %s\n" % (format % args).encode("ascii", "replace").decode("ascii")
        )

    def do_GET(self):
        body = {"object": "list", "data": [{"id": "openloomi-agent", "object": "model"}]}
        _write_json_response(self, 200, body)

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/chat/completions", "/chat/completions"):
            _write_error(self, 404, "not found")
            return

        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as e:
            _write_error(self, 400, f"invalid json body: {type(e).__name__}")
            return

        messages = payload.get("messages") or []
        try:
            prompt = build_prompt_from_messages(messages)
            started = time.time()
            answer = call_native_agent(
                prompt, self.openloomi_base, self.openloomi_token
            )
            elapsed = time.time() - started
        except Exception as e:
            # ASCII-safe message so the response itself never trips encoding.
            msg = ("upstream failed: " + repr(e)).encode("ascii", "replace").decode("ascii")
            _write_error(self, 502, msg)
            return

        resp = {
            "id": f"chatcmpl-proxy-{int(time.time()*1000)}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": payload.get("model") or "openloomi-agent",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": answer},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": len(prompt),
                "completion_tokens": len(answer),
                "total_tokens": len(prompt) + len(answer),
            },
            "_openloomi_elapsed_s": round(elapsed, 2),
        }
        _write_json_response(self, 200, resp)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3800)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--openloomi-port", type=int, default=3515)
    parser.add_argument(
        "--openloomi-token",
        default=os.environ.get("OPENLOOMI_TOKEN"),
        help="Bearer token; if unset, read $env:USERPROFILE/.openloomi/token",
    )
    args = parser.parse_args()

    if not args.openloomi_token:
        token_path = os.path.join(
            os.environ.get("USERPROFILE", str(Path.home())), ".openloomi", "token"
        )
        try:
            with open(token_path, "r", encoding="utf-8") as f:
                args.openloomi_token = f.read().strip()
        except Exception as e:
            sys.stderr.write(f"failed to read token file {token_path}: {e}\n")
            sys.exit(2)

    ProxyHandler.openloomi_base = f"http://127.0.0.1:{args.openloomi_port}"
    ProxyHandler.openloomi_token = args.openloomi_token

    server = ThreadingHTTPServer((args.bind, args.port), ProxyHandler)
    sys.stderr.write(
        f"[proxy] listening on http://{args.bind}:{args.port}/v1/chat/completions "
        f"-> {ProxyHandler.openloomi_base}/api/native/agent\n"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()