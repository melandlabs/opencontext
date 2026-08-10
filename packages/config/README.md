# config (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


Shared build, lint, and TypeScript presets used across every package in the
OpenContext monorepo. Centralises `tsup`, ESLint, and `tsconfig` configuration so
each package's `package.json` stays minimal.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `config` — Main entrypoint (compiled `dist/index.js`)
- `config/eslint` — Pre-bundled ESLint configuration
- `config/tsconfig` — Shared `tsconfig.json` base
- `config/tsup-preset` — `tsup` preset factory (`makeTsupConfig`)
