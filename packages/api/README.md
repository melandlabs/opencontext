# api (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Lightweight HTTP client helpers used by the OpenContext web app and other
packages. Wraps `fetch` with unified error handling and exposes a typed
`ApiError` for status / payload propagation.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `ApiError` — Error class carrying `message`, `status`, and `details`
- `fetchApi<T>()` — Promise-returning `fetch` wrapper that parses JSON and
  raises `ApiError` on non-2xx responses
