# integrations-calendar (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Google Calendar integration for OpenContext. Built on the official
[`googleapis`](https://www.npmjs.com/package/googleapis) SDK and supports
event listing, creation, and OAuth credential management.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `integrations-calendar` — Calendar adapter and helpers

## Peer Dependencies

- `react >=18.0.0` (for the React UI components)
