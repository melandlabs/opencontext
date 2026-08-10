# integrations-asana (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

[Asana](https://asana.com/) integration for OpenContext. Provides a typed
client and React UI primitives for working with Asana tasks, projects, and
workspaces.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `integrations-asana` — Main entrypoint (adapters + helpers)
- `integrations-asana/client` — Typed Asana REST client

## Peer Dependencies

- `react >=18.0.0` (for the React UI components)
