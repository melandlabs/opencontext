# @openloomi/integrations-composio

[Composio](https://composio.dev/) adapter helpers for OpenLoomi. Exposes the
shared `ComposioClient`, toolkit slug constants, and credential helpers used
by the Google Calendar / Google Meet integrations.

## Installation

```sh
pnpm add @openloomi/integrations-composio
```

## Exports

- `ComposioClient` — Typed Composio client wrapper
- `COMPOSIO_GOOGLE_CALENDAR_TOOLKIT`, `COMPOSIO_GOOGLE_MEET_TOOLKIT` —
  Toolkit slug constants
- `ComposioToolkitSlug`, `ComposioCredentials`, `ComposioConnectLink` — Types
- `isComposioCredentials()` — Runtime type guard
- `ComposioIntegrationError` — Error class
