---
"@melandlabs/memory-store": patch
---

Load `@melandlabs/okf/http` and `@melandlabs/okf/mcp` lazily inside the HTTP / MCP server start functions instead of via static `import`. This breaks the workspace DTS cycle between memory-store and OKF (memory-store → okf via `dependencies`, okf → memory-store via `devDependencies`) so `pnpm -r build` can serialize memory-store before OKF and emit `dist/http.d.ts` / `dist/mcp.d.ts` without needing OKF's types on disk first. Runtime behavior is unchanged — `@melandlabs/okf` remains a regular `dependency` so the dynamic `import()` resolves at startup in any host that already has the OKF package installed.

Also unblocks the release workflow's `publish` job, which has been red since the v0.2 OKF release because the same DTS cycle crashed memory-store's `tsup --dts` step before it could produce the tarballs that the `smoke` job installs from npmjs.org.