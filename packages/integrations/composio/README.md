# integrations-composio (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

[Composio](https://composio.dev/) adapter helpers for OpenContext. Exposes the
shared `ComposioClient`, toolkit slug constants, and credential helpers used
by the Google Calendar / Google Meet integrations.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `ComposioClient` — Typed Composio client wrapper
- `COMPOSIO_GOOGLE_CALENDAR_TOOLKIT`, `COMPOSIO_GOOGLE_MEET_TOOLKIT` —
  Toolkit slug constants
- `ComposioToolkitSlug`, `ComposioCredentials`, `ComposioConnectLink` — Types
- `isComposioCredentials()` — Runtime type guard
- `ComposioIntegrationError` — Error class
