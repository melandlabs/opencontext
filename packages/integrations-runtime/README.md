# `@opencontext/integrations-runtime`

Phase 7 dep-free leaf of `apps/web/lib/integrations/` — the per-platform
glue (authorization errors, platform connectability, platform visuals,
task-integration inference, OAuth callback script) that the UI + the
per-platform integration packages both need.

Per-platform packages (`@opencontext/integrations/{gmail,slack,whatsapp,...}`)
and the UI both import from here. Heavy glue (DB, session, auth token
manager) stays inside `apps/web/lib/integrations/` for now and will
move in a later phase once the runtime services have their own
Hono/MCP daemons.

| Subpath                             | Source                              | Notes                                                                   |
| ----------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `@opencontext/integrations-runtime` | `src/index.ts`                      | Re-exports the subpaths below                                           |
| `.../authorization-errors`          | `src/authorization-errors.ts`       | `AuthorizationError` discriminated union + `describeAuthorizationError` |
| `.../platform-visuals`              | `src/platform-visuals.ts`           | Brand colors, icons, display names for every `IntegrationId`            |
| `.../platform-connectability`       | `src/platform-connectability.ts`    | `isIntegrationPlatformConnectable`, connector-target helpers            |
| `.../task-integration-inference`    | `src/task-integration-inference.ts` | Maps task labels → integration IDs / connector-target actions           |
| `.../oauth-callback-script`         | `src/oauth-callback-script.ts`      | Tiny `postMessage(...)` bridge for the OAuth popup close path           |
