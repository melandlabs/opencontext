# integrations-instagram (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


[Instagram](https://developers.facebook.com/docs/instagram-api) messaging
adapter for OpenContext. Sends and receives Instagram DM conversations
through the Meta Graph API.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `InstagramAdapter` — Channel adapter implementation
