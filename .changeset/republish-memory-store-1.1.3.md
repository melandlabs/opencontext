---
"@melandlabs/memory-store": patch
---

Republish to replace the workspace:* deps that slipped into 1.1.2.

`memory-store@1.1.2` was uploaded with raw `workspace:*` specifiers (e.g.
`@melandlabs/ai: workspace:*`) after a manual version bump to dodge
npm's 24-hour republish cooldown. Downstream installs that resolve
against the public registry — most importantly the release `smoke`
job, which runs `pnpm install --ignore-workspace` against npmjs.org —
fail with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` because no workspace
exists outside the monorepo.

Bumping to 1.1.3 routes through `pnpm changeset publish`, which calls
`pnpm pack` to generate the tarball. `pnpm pack` substitutes the
linked workspace versions into the packaged `package.json`, so the
published artifact carries versioned deps (`@melandlabs/ai: 0.7.0`,
`@melandlabs/okf: 0.2.0`, …) — verified locally against the same
`packages/memory-store` tree that the release workflow builds.

No source change vs 1.1.1 / 1.1.2; the `factType?: FactType` type
addition to `RawMessage` and the OKF HTTP / MCP wiring are already
shipped. 1.1.2 is deprecated on npm with a pointer to 1.1.3.
