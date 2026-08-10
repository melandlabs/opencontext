# integrations-imessage (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


[iMessage](https://support.apple.com/messages) integration for OpenContext,
powered by [`@photon-ai/imessage-kit`](https://www.npmjs.com/package/@photon-ai/imessage-kit)
on macOS. Lets bots send and receive iMessage / SMS conversations.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `integrations-imessage` — Main entrypoint
- `integrations-imessage/adapter` — `IMessageAdapter` class
