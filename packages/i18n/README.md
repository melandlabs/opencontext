# i18n (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Locale message bundles used across the OpenContext web app. Ships the raw
strings as ESM modules so they can be tree-shaken into a host app's i18n
runtime.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `i18n` — Re-exports of every locale (default entrypoint)
- `i18n/locales/en-US` — English (US) strings
- `i18n/locales/zh-Hans` — Simplified Chinese strings
