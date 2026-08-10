# `@opencontext/contracts`

Cross-cutting type contracts shared between the OpenLoomi **runtime** sub-project
(memory / context / environment / agent) and the **UI** sub-project (Next.js +
Tauri + components).

This package contains only **types, enums, and zod schemas** — no runtime logic.
It is the canonical source of truth for boundary shapes. Both sub-projects
consume it; neither sub-project owns it.

## Contents

| Sub-path | What it defines | Used by |
|---|---|---|
| `@opencontext/contracts` (root) | barrel — re-exports everything | everyone |
| `@opencontext/contracts/user-type` | `UserType = "guest" \| "regular" \| "basic" \| "pro" \| "team"` + `isUserType`, `USER_TYPES` | auth, db, integrations, UI route groups |
| `@opencontext/contracts/integration-id` | `IntegrationId` (branded string union of 27 platforms) + `isIntegrationId`, `INTEGRATION_IDS` | integrations, UI hooks, route handlers |
| `@opencontext/contracts/errors` | `AuthErrorCode` enum | auth, UI forms, route handlers |
| `@opencontext/contracts/schemas` | `UserTypeSchema`, `IntegrationIdSchema` (zod) | runtime parsers, UI form validation |

## Why this exists

Before this package, `UserType` lived in `apps/web/app/(auth)/auth.ts:36` and
was imported (as a type-only) by 20+ runtime files. That made it impossible to
run any backend code without pulling in NextAuth, which made it impossible to
ship runtime code as standalone daemons (Hono HTTP, MCP stdio).

After this package, both runtime packages and the UI can depend on the same
canonical shape, with no NextAuth / React leakage.

## Phase plan

- **Phase 0** (this PR): package skeleton + barrel, types defined here, nothing moved yet.
- **Phase 2**: `apps/web/app/(auth)/auth.ts` re-exports `UserType` from here;
  20+ runtime files switch their import source.
- **Phase 3**: `apps/web/hooks/use-integrations.ts` re-exports `IntegrationId`
  from here; 7 runtime files switch their import source.

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

Produces `dist/` with ESM + .d.ts. Bundled through the shared tsup preset
inherited via the per-package `tsup.config.ts`.