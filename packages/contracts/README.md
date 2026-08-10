# `contracts`

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


Cross-cutting type contracts. Types, enums, and zod schemas only — no
runtime logic. Canonical source of truth for boundary shapes.

## Contents

| Sub-path                                | What it defines                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `contracts` (root)         | Barrel — re-exports everything                                                                |
| `contracts/user-type`      | `UserType = "guest" \| "regular" \| "basic" \| "pro" \| "team"` + `isUserType`, `USER_TYPES`  |
| `contracts/integration-id` | `IntegrationId` (branded string union of 27 platforms) + `isIntegrationId`, `INTEGRATION_IDS` |
| `contracts/errors`         | `AuthErrorCode` enum                                                                          |
| `contracts/schemas`        | `UserTypeSchema`, `IntegrationIdSchema` (zod)                                                 |

## Conventions

- **No `react`, `next`, `@tauri-apps/api`, `bcrypt-ts`, etc.** — this package
  must remain pure.
- **`zod` is an optional peer dependency.** Only `schemas.ts` imports from it;
  the rest of the package has zero runtime deps.
- **No domain types here.** Domain-specific shapes belong in their owning
  runtime package (e.g. memory graph contracts live in `memory-store`).

## Build

```
pnpm --filter @melandlabs/contracts build
```

Produces `dist/` with ESM + .d.ts via the shared tsup preset.
