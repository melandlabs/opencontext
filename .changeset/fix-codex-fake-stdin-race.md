---
"@melandlabs/ai": patch
---

Fix CodexAgent test plumbing flake on darwin CI. `defaultFakeCodexScript`
now drains stdin before persisting argv/stdin to disk; on heavily-loaded
macOS runners the previous "writeFileSync first, attach listeners second"
ordering could lose the race against an early child exit, surfacing as
ENOENT on the post-run `readFile`. The `data`/`end` listeners are still
attached eagerly so `proc.stdin.end()` cannot surface as EPIPE either.