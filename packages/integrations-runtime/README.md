# `integrations-runtime`

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


Dep-free glue shared between the per-platform integration packages and the
UI — authorization errors, platform connectability, platform visuals,
task-integration inference, OAuth callback bridge.

| Subpath                             | Source                              | Notes                                                                   |
| ----------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `integrations-runtime` | `src/index.ts`                      | Re-exports the subpaths below                                           |
| `.../authorization-errors`          | `src/authorization-errors.ts`       | `AuthorizationError` discriminated union + `describeAuthorizationError` |
| `.../platform-visuals`              | `src/platform-visuals.ts`           | Brand colors, icons, display names for every `IntegrationId`            |
| `.../platform-connectability`       | `src/platform-connectability.ts`    | `isIntegrationPlatformConnectable`, connector-target helpers            |
| `.../task-integration-inference`    | `src/task-integration-inference.ts` | Maps task labels → integration IDs / connector-target actions           |
| `.../oauth-callback-script`         | `src/oauth-callback-script.ts`      | `postMessage(...)` bridge for the OAuth popup close path                |

No DB, no session storage — those live in the host application.
