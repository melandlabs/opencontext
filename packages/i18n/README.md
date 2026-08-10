# @opencontext/i18n

Locale message bundles used across the OpenContext web app. Ships the raw
strings as ESM modules so they can be tree-shaken into a host app's i18n
runtime.

## Installation

```sh
pnpm add @opencontext/i18n
```

## Exports

- `@opencontext/i18n` — Re-exports of every locale (default entrypoint)
- `@opencontext/i18n/locales/en-US` — English (US) strings
- `@opencontext/i18n/locales/zh-Hans` — Simplified Chinese strings
