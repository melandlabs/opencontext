"""OpenAI-compatible proxy that lets Tencent's official CL-bench infer.py /
eval.py run against the opencontext memory-store daemon.

Flow per POST /v1/chat/completions { model, messages, stream? }:
1. Take the LAST user message as the question Q; all other messages are context.
2. Derive an isolated userId (clbench_<sha1(messages)[:16]>) so samples never
   pollute each other's memories and retries are idempotent.
3. Ingest the context messages into opencontext via POST /v1/raw-messages
   (messageId = <userId>_m<i>, so re-ingesting the same sample is a no-op).
4. Retrieve memories via POST /v1/search with Q.
5. Answer with an LLM (Anthropic-compatible endpoint if ANTHROPIC_AUTH_TOKEN is
   set, otherwise OpenRouter via OPENROUTER_API_KEY) using ONLY the retrieved
   snippets.
6. Wrap the answer in an OpenAI chat.completion response (SSE if stream=true).

Run:
    python opencontext_proxy.py --port 3800 --opencontext-url http://127.0.0.1:7421

Then point infer.py at:
    --base-url http://127.0.0.1:3800/v1
"""
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


# --------------------------------------------------------------------------
# .env loading (simple key=value parser)
# --------------------------------------------------------------------------
def load_dotenv(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        pass


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def extract_text(content):
    """OpenAI content may be a string or a list of content blocks."""
    if isinstance(content, list):
        return "".join(
            b.get("text", "") for b in content if isinstance(b, dict)
        )
    return content if isinstance(content, str) else ""


def split_question(messages):
    """Return (context_messages, question_text)."""
    last_user_idx = None
    for i, msg in enumerate(messages):
        if msg.get("role") == "user":
            last_user_idx = i
    if last_user_idx is None:
        return messages, ""
    context = [m for i, m in enumerate(messages) if i != last_user_idx]
    return context, extract_text(messages[last_user_idx].get("content"))


def derive_user_id(messages):
    raw = json.dumps(messages, ensure_ascii=False, sort_keys=True)
    return "clbench_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def http_post_json(url, body, headers=None, timeout=600):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# --------------------------------------------------------------------------
# opencontext memory store
# --------------------------------------------------------------------------
ROLE_PREFIX = {"user": "User", "assistant": "Assistant", "system": "System"}


def ingest_context(opencontext_base, user_id, context):
    now_ms = int(time.time() * 1000)
    msgs = []
    for i, msg in enumerate(context):
        text = extract_text(msg.get("content"))
        if not text.strip():
            continue
        prefix = ROLE_PREFIX.get(msg.get("role"), str(msg.get("role", "Message")).title())
        msgs.append(
            {
                "messageId": f"{user_id}_m{i}",
                "userId": user_id,
                "platform": "clbench",
                "botId": "clbench-proxy",
                "timestamp": now_ms + i,
                "content": f"{prefix}: {text}",
                "createdAt": now_ms + i,
            }
        )
    if not msgs:
        return 0
    http_post_json(
        f"{opencontext_base}/v1/raw-messages",
        {"userId": user_id, "messages": msgs, "embedOnInsert": True},
        timeout=600,
    )
    return len(msgs)


def search_memories(opencontext_base, user_id, query, limit):
    data = http_post_json(
        f"{opencontext_base}/v1/search",
        {"userId": user_id, "query": query, "limit": limit, "sources": ["memory"]},
        timeout=120,
    )
    return data.get("results") or []


# --------------------------------------------------------------------------
# answer LLM
# --------------------------------------------------------------------------
def build_answer_prompt(memories, question):
    snippets = []
    for i, mem in enumerate(memories, 1):
        snippets.append(f"[{i}] {mem.get('content', '')}")
    memory_block = "\n\n".join(snippets) if snippets else "(no memories retrieved)"
    return (
        "You are answering a question based on a conversation history that has "
        "been stored in a memory system. Below are the memory snippets retrieved "
        "for this question.\n\n"
        "=== Retrieved memories ===\n"
        f"{memory_block}\n"
        "=== End of memories ===\n\n"
        f"Question: {question}\n\n"
        "Instructions:\n"
        "- Answer ONLY based on the retrieved memory snippets above.\n"
        "- If the memories do not contain enough information to answer, say that "
        "you don't know — do NOT make things up.\n"
        "- Respond in the same language as the question."
    )


def call_anthropic(prompt):
    base = os.environ.get("ANTHROPIC_BASE_URL", "https://api.minimaxi.com/anthropic")
    token = os.environ["ANTHROPIC_AUTH_TOKEN"]
    model = os.environ.get("ANSWER_MODEL", "MiniMax-M3-highspeed")
    data = http_post_json(
        f"{base.rstrip('/')}/v1/messages",
        {
            "model": model,
            "max_tokens": 4096,
            "messages": [{"role": "user", "content": prompt}],
        },
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-version": "2023-06-01",
        },
        timeout=1200,
    )
    parts = data.get("content") or []
    return "".join(
        b.get("text", "") for b in parts if isinstance(b, dict) and b.get("type") == "text"
    )


def call_openrouter(prompt):
    key = os.environ["OPENROUTER_API_KEY"]
    model = os.environ.get("OPENROUTER_ANSWER_MODEL", "deepseek/deepseek-chat")
    data = http_post_json(
        "https://openrouter.ai/api/v1/chat/completions",
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
        },
        headers={"Authorization": f"Bearer {key}"},
        timeout=1200,
    )
    return data["choices"][0]["message"]["content"]


def call_answer_llm(prompt):
    if os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return call_anthropic(prompt), "anthropic"
    if os.environ.get("OPENROUTER_API_KEY"):
        return call_openrouter(prompt), "openrouter"
    raise RuntimeError(
        "no answer LLM configured: set ANTHROPIC_AUTH_TOKEN or OPENROUTER_API_KEY"
    )


# --------------------------------------------------------------------------
# response writers
# --------------------------------------------------------------------------
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
        pass


def _write_sse_response(handler, model, answer):
    """Stream the answer as OpenAI-compatible SSE chunks."""
    cmpl_id = f"chatcmpl-proxy-{int(time.time() * 1000)}"
    created = int(time.time())

    def chunk(delta, finish_reason=None):
        return {
            "id": cmpl_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [
                {"index": 0, "delta": delta, "finish_reason": finish_reason}
            ],
        }

    lines = []
    lines.append(json.dumps(chunk({"role": "assistant"}, None), ensure_ascii=False))
    # split the answer into small pieces so clients see a real stream
    step = 512
    for i in range(0, max(len(answer), 1), step):
        piece = answer[i : i + step]
        if piece:
            lines.append(json.dumps(chunk({"content": piece}, None), ensure_ascii=False))
    lines.append(json.dumps(chunk({}, "stop"), ensure_ascii=False))

    payload = "".join(f"data: {line}\n\n" for line in lines).encode("utf-8")
    payload += b"data: [DONE]\n\n"
    head = (
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/event-stream; charset=utf-8\r\n"
        f"Content-Length: {len(payload)}\r\n"
        "Connection: close\r\n"
        "\r\n"
    ).encode("ascii")
    try:
        handler.wfile.write(head)
        handler.wfile.write(payload)
        handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass


def _write_error(handler, status, message):
    body = {"error": {"message": message, "type": "proxy_error", "code": status}}
    _write_json_response(handler, status, body)


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------
class ProxyHandler(BaseHTTPRequestHandler):
    opencontext_base = None
    search_limit = 10

    def log_message(self, format, *args):
        sys.stderr.write(
            "[proxy] %s\n" % (format % args).encode("ascii", "replace").decode("ascii")
        )

    def do_GET(self):
        if self.path.rstrip("/") not in ("/v1/models", "/models"):
            _write_error(self, 404, "not found")
            return
        body = {
            "object": "list",
            "data": [{"id": "opencontext-cl", "object": "model"}],
        }
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
        if not messages:
            _write_error(self, 400, "no messages")
            return

        started = time.time()
        try:
            context, question = split_question(messages)
            user_id = derive_user_id(messages)

            ingested = ingest_context(self.opencontext_base, user_id, context)
            memories = search_memories(
                self.opencontext_base, user_id, question, self.search_limit
            )
            prompt = build_answer_prompt(memories, question)
            answer, backend = call_answer_llm(prompt)
            elapsed = time.time() - started
            self.log_message(
                "user=%s ctx=%d mems=%d backend=%s %.1fs",
                user_id, ingested, len(memories), backend, elapsed,
            )
        except Exception as e:
            msg = ("upstream failed: " + repr(e)).encode("ascii", "replace").decode("ascii")
            _write_error(self, 502, msg)
            return

        model = payload.get("model") or "opencontext-cl"

        if payload.get("stream"):
            _write_sse_response(self, model, answer)
            return

        resp = {
            "id": f"chatcmpl-proxy-{int(time.time() * 1000)}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
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
            "_opencontext_elapsed_s": round(elapsed, 2),
            "_opencontext_user_id": user_id,
            "_opencontext_memories": len(memories),
        }
        _write_json_response(self, 200, resp)


def main():
    load_dotenv(Path(__file__).resolve().parent / ".env")

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3800)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--opencontext-url", default="http://127.0.0.1:7421")
    args = parser.parse_args()

    ProxyHandler.opencontext_base = args.opencontext_url.rstrip("/")
    ProxyHandler.search_limit = int(os.environ.get("CLBENCH_SEARCH_LIMIT", "10"))

    backend = (
        "anthropic (" + os.environ.get("ANSWER_MODEL", "MiniMax-M3-highspeed") + ")"
        if os.environ.get("ANTHROPIC_AUTH_TOKEN")
        else "openrouter (" + os.environ.get("OPENROUTER_ANSWER_MODEL", "deepseek/deepseek-chat") + ")"
        if os.environ.get("OPENROUTER_API_KEY")
        else "NONE (set ANTHROPIC_AUTH_TOKEN or OPENROUTER_API_KEY)"
    )

    server = ThreadingHTTPServer((args.bind, args.port), ProxyHandler)
    sys.stderr.write(
        f"[proxy] listening on http://{args.bind}:{args.port}/v1/chat/completions\n"
        f"[proxy] opencontext: {ProxyHandler.opencontext_base} "
        f"(search limit {ProxyHandler.search_limit})\n"
        f"[proxy] answer backend: {backend}\n"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
