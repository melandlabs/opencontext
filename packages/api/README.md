# @openloomi/api

Lightweight HTTP client helpers used by the OpenLoomi web app and other
packages. Wraps `fetch` with unified error handling and exposes a typed
`ApiError` for status / payload propagation.

## Installation

```sh
pnpm add @openloomi/api
```

## Exports

- `ApiError` — Error class carrying `message`, `status`, and `details`
- `fetchApi<T>()` — Promise-returning `fetch` wrapper that parses JSON and
  raises `ApiError` on non-2xx responses
