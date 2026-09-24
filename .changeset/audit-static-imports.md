---
"@melandlabs/audit": patch
---

Replace CommonJS `require()` with static ESM imports inside the interceptor and
logger. The package is published as ESM (`format: ["esm"]`, `"type": "module"`),
so the previous `require()` calls inside `installAuditInterceptors()` were
rejected by Next.js / Turbopack bundlers with `dynamic usage of require is not
supported`, leaving the audit interceptors silently un-installed on the server.
Adds a `tsconfig.json` extending the shared bundler-resolution config so the
`@melandlabs/env-config/app-paths` subpath import resolves cleanly. Native
`fs` / `child_process` monkey-patching is now done through `any`-typed aliases
so esbuild accepts the property assignment.
