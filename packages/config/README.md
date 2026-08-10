# @opencontext/config

Shared build, lint, and TypeScript presets used across every package in the
OpenContext monorepo. Centralises `tsup`, ESLint, and `tsconfig` configuration so
each package's `package.json` stays minimal.

## Installation

```sh
pnpm add @opencontext/config
```

## Subpath Exports

- `@opencontext/config` — Main entrypoint (compiled `dist/index.js`)
- `@opencontext/config/eslint` — Pre-bundled ESLint configuration
- `@opencontext/config/tsconfig` — Shared `tsconfig.json` base
- `@opencontext/config/tsup-preset` — `tsup` preset factory (`makeTsupConfig`)
