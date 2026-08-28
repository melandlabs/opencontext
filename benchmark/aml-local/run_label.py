"""Issue a unique AML Run Label for an official evaluation run.

Format:  opencontext-<pkg version>-<yyyymmdd>-<purpose>-<n>
Example: opencontext-0.8.0-20260828-official-1

Each issued label is appended to outputs/run_labels.log together with the
git commit and (if given) the container image digest, so the label ↔ code ↔
image mapping stays auditable. outputs/ is gitignored — copy the line into
SUBMISSION.md or the platform application if you want it on record.

Usage:
  python run_label.py official                  # prints and records
  python run_label.py official --image sha256:49cbfd...   # also record digest
  python run_label.py --dry-run smoke           # print only, don't record
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
PKG_JSON = REPO / "packages" / "opencontext" / "package.json"
LOG = HERE / "outputs" / "run_labels.log"


def pkg_version() -> str:
    try:
        return json.loads(PKG_JSON.read_text(encoding="utf-8"))["version"]
    except Exception:
        return "0.0.0-unknown"


def git_sha() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], cwd=REPO, capture_output=True, text=True, check=True
        ).stdout.strip()
    except Exception:
        return "nogit"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("purpose", help="short purpose slug, e.g. official, smoke, retry")
    parser.add_argument("--image", help="container image digest (sha256:...) to record alongside")
    parser.add_argument("--dry-run", action="store_true", help="print only, do not record")
    args = parser.parse_args()

    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    stem = f"opencontext-{pkg_version()}-{today}-{args.purpose}"

    used = set()
    if LOG.exists():
        for line in LOG.read_text(encoding="utf-8").splitlines():
            used.add(line.split()[0] if line.strip() else "")
    n = 1
    while f"{stem}-{n}" in used:
        n += 1
    label = f"{stem}-{n}"

    print(label)
    if not args.dry_run:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as f:
            f.write(f"{label}\tcommit={git_sha()}\timage={args.image or '-'}\tissued={datetime.now(timezone.utc).isoformat()}\n")
        print(f"recorded in {LOG}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
