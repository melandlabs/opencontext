# `@opencontext/contracts`

Cross-cutting type contracts. Types, enums, and zod schemas only — no
runtime logic. Canonical source of truth for boundary shapes.

## Contents

| Sub-path                                | What it defines                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `@opencontext/contracts` (root)         | Barrel — re-exports everything                                                                |
| `@opencontext/contracts/user-type`      | `UserType = "guest" \| "regular" \| "basic" \| "pro" \| "team"` + `isUserType`, `USER_TYPES`  |
| `@opencontext/contracts/integration-id` | `IntegrationId` (branded string union of 27 platforms) + `isIntegrationId`, `INTEGRATION_IDS` |
| `@opencontext/contracts/errors`         | `AuthErrorCode` enum                                                                          |
| `@opencontext/contracts/schemas`        | `UserTypeSchema`, `IntegrationIdSchema` (zod)                                                 |

## Conventions

- **No `react`, `next`, `@tauri-apps/api`, `bcrypt-ts`, etc.** — this package
  must remain pure.
- **`zod` is an optional peer dependency.** Only `schemas.ts` imports from it;
  the rest of the package has zero runtime deps.
- **No domain types here.** Domain-specific shapes belong in their owning
  runtime package (e.g. memory graph contracts live in `@opencontext/memory-store`).

## Build

```
pnpm --filter @opencontext/contracts build
```

Produces `dist/` with ESM + .d.ts via the shared tsup preset.
