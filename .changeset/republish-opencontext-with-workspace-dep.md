---
"@melandlabs/opencontext": patch
---

Republish `@melandlabs/opencontext` so the `0.9.0` tarball picks up the `@melandlabs/workspace` runtime dependency that PR #38 wired into the CLI (`opencontext workspace update|search|list`). Without this republish, `pnpm dlx @melandlabs/opencontext@0.9.0 workspace …` fails with `Cannot find package '@melandlabs/workspace'`.
