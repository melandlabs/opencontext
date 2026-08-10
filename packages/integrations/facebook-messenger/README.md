# integrations-facebook-messenger (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

[Facebook Messenger](https://developers.facebook.com/docs/messenger-platform/)
adapter for OpenContext. Sends and receives page messages through the Meta
Messenger Platform.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `FacebookMessengerAdapter` — Channel adapter implementation
- Page / app credential helpers
