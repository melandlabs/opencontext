# integrations-google-meet (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

[Google Meet](https://developers.google.com/meet) integration for OpenContext.
Uses Composio under the hood to drive meeting scheduling, attendee
management, and recording retrieval.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `GoogleMeetAdapter` — Channel adapter implementation
