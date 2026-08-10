# @openloomi/config

Shared build, lint, and TypeScript presets used across every package in the
OpenLoomi monorepo. Centralises `tsup`, ESLint, and `tsconfig` configuration so
each package's `package.json` stays minimal.

## Installation

```sh
pnpm add @openloomi/config
```

## Subpath Exports

- `@openloomi/config` — Main entrypoint (compiled `dist/index.js`)
- `@openloomi/config/eslint` — Pre-bundled ESLint configuration
- `@openloomi/config/tsconfig` — Shared `tsconfig.json` base
- `@openloomi/config/tsup-preset` — `tsup` preset factory (`makeTsupConfig`)
