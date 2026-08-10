# integrations-linkedin (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

[LinkedIn](https://www.linkedin.com/) messaging adapter for OpenContext.
Authenticates with LinkedIn OAuth 2.0 and exchanges direct messages on
behalf of the connected user.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `LinkedInAdapter` — Channel adapter implementation
- `LinkedInCredentials` — OAuth credential type
