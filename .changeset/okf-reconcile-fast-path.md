---
"@melandlabs/workspace": minor
---

Reconcile fast path + extraction size cap for OKF folder indexing.

- `indexOkfFolder` now walks and stats files first and only runs `extractText` on files whose stored `source_mtime` + `size_bytes` no longer match the on-disk file. Steady-state reconciles of large folders go from full re-extraction to walk + stat + extract-changed-only. An mtime+size match is trusted the way git/rsync trust it: a content edit that deliberately preserves both (same-length rewrite with a reset mtime) is not detected until mtime or size changes. Live watcher writes still go through per-file sha256 dedup in `indexResource`, so their semantics are unchanged.
- The shared folder walk now skips files larger than `OKF_MAX_EXTRACT_BYTES` (32 MiB, exported from the barrel) with a warning instead of attempting to parse them. Oversized files never enter the reconcile's present-key set, so a file that was indexed before it grew past the cap is soft-deleted on the next reconcile; shrink it back under the cap and a later reconcile restores it.
