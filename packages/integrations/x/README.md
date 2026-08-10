# integrations-x (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


[X (formerly Twitter)](https://developer.x.com/) DM integration for OpenContext,
powered by the official
[`@xdevplatform/xdk`](https://www.npmjs.com/package/@xdevplatform/xdk).
Sends and receives X direct messages on behalf of the authenticated user.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `XAdapter` — Channel adapter implementation
- `XCredentials` — OAuth credential type
