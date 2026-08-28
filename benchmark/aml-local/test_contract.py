"""Offline + live contract smoke tests for the AML Add/Search adapter.

Offline mode (default) validates every fixture in `fixtures/` against the
JSON Schemas in `contract/` — no daemon, no network, no eval key needed:

    python test_contract.py

Live mode additionally POSTs the request fixtures to a running adapter and
schema-validates the real responses (start `serve.py` + the daemon first):

    python test_contract.py --live http://127.0.0.1:7422 [--api-key KEY]

Uses the `jsonschema` package when installed; otherwise falls back to a
small built-in validator covering the keywords used by contract/*.json.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONTRACT = HERE / "contract"
FIXTURES = HERE / "fixtures"

# fixture file -> schema file
CASES = {
    "add.example.json": "add.schema.json",
    "add.response.example.json": "add-response.schema.json",
    "search.example.json": "search.schema.json",
    "search.response.example.json": "search-response.schema.json",
    "health.response.example.json": "health.schema.json",
}

TYPE_MAP = {
    "object": dict,
    "array": list,
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
}


def _fallback_validate(instance, schema, path="$"):
    """Minimal validator: type/required/properties/items/const/min*/enum."""
    errors = []
    stype = schema.get("type")
    if stype:
        allowed = stype if isinstance(stype, list) else [stype]
        ok = False
        for t in allowed:
            py = TYPE_MAP[t]
            # bool is a subclass of int in Python — keep them distinct
            if t in ("integer", "number") and isinstance(instance, bool):
                continue
            if isinstance(instance, py):
                ok = True
                break
        if not ok:
            errors.append(f"{path}: expected type {allowed}, got {type(instance).__name__}")
            return errors
    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: expected const {schema['const']!r}, got {instance!r}")
    if isinstance(instance, dict):
        for req in schema.get("required", []):
            if req not in instance:
                errors.append(f"{path}: missing required property {req!r}")
        props = schema.get("properties", {})
        for key, value in instance.items():
            if key in props:
                errors += _fallback_validate(value, props[key], f"{path}.{key}")
    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: expected at least {schema['minItems']} items")
        item_schema = schema.get("items")
        if item_schema:
            for i, item in enumerate(instance):
                errors += _fallback_validate(item, item_schema, f"{path}[{i}]")
    if isinstance(instance, str) and "minLength" in schema and len(instance) < schema["minLength"]:
        errors.append(f"{path}: string shorter than minLength {schema['minLength']}")
    if isinstance(instance, int) and not isinstance(instance, bool) and "minimum" in schema:
        if instance < schema["minimum"]:
            errors.append(f"{path}: {instance} < minimum {schema['minimum']}")
    return errors


def validate(instance, schema):
    try:
        import jsonschema  # type: ignore
    except ImportError:
        return _fallback_validate(instance, schema)
    validator = jsonschema.Draft202012Validator(schema)
    return [f"{'$' + ''.join(f'[{p!r}]' if isinstance(p, int) else '.' + str(p) for p in e.absolute_path)}: {e.message}" for e in validator.iter_errors(instance)]


def load_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def post(base: str, path: str, payload: dict, api_key: str | None) -> tuple[int, dict]:
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", metavar="BASE_URL", help="also test a running adapter, e.g. http://127.0.0.1:7422")
    parser.add_argument("--api-key", help="Memory System Key for live mode (Authorization: Bearer)")
    args = parser.parse_args()

    failures = 0
    for fixture_name, schema_name in CASES.items():
        fixture = load_json(FIXTURES / fixture_name)
        schema = load_json(CONTRACT / schema_name)
        errors = validate(fixture, schema)
        status = "ok" if not errors else "FAIL"
        print(f"[{status}] fixtures/{fixture_name} vs contract/{schema_name}")
        for e in errors:
            print(f"    {e}")
        failures += len(errors)

    if args.live:
        base = args.live
        print(f"\n-- live mode against {base} --")
        live_cases = [
            ("POST", "/add", "add.example.json", "add-response.schema.json"),
            ("POST", "/search", "search.example.json", "search-response.schema.json"),
        ]
        with urllib.request.urlopen(base.rstrip("/") + "/health", timeout=10) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            errors = validate(body, load_json(CONTRACT / "health.schema.json"))
            status = "ok" if resp.status == 200 and not errors else "FAIL"
            print(f"[{status}] GET /health -> {resp.status}")
            failures += len(errors) + (0 if resp.status == 200 else 1)
        for _, path, fixture_name, schema_name in live_cases:
            code, body = post(base, path, load_json(FIXTURES / fixture_name), args.api_key)
            errors = validate(body, load_json(CONTRACT / schema_name)) if code == 200 else [f"HTTP {code}: {body}"]
            status = "ok" if not errors else "FAIL"
            print(f"[{status}] POST {path} -> {code}")
            for e in errors:
                print(f"    {e}")
            failures += len(errors)

    print(f"\n{'PASS' if failures == 0 else 'FAIL'} ({failures} problem(s))")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
