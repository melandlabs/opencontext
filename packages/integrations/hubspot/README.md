# integrations-hubspot (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


[HubSpot](https://www.hubspot.com/) CRM integration for OpenContext. Provides a
typed client for deals, pipeline stages, and credential persistence.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `integrations-hubspot` — Main entrypoint
- `integrations-hubspot/client` — `HubspotClient` and credential
  types (`HubspotCredentials`, `HubspotDeal`, `HubspotPipelineStage`,
  `PersistCredentialsOptions`)
