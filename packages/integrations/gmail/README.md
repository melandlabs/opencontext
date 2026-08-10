# integrations-gmail (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Gmail integration for OpenContext focused on persisting Gmail threads /
messages into the conversation store for later search and triage.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `integrations-gmail/conversation-store` — Gmail-thread to
  `RawMessageManager` bridge
