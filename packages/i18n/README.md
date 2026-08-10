# @openloomi/i18n

Locale message bundles used across the OpenLoomi web app. Ships the raw
strings as ESM modules so they can be tree-shaken into a host app's i18n
runtime.

## Installation

```sh
pnpm add @openloomi/i18n
```

## Exports

- `@openloomi/i18n` — Re-exports of every locale (default entrypoint)
- `@openloomi/i18n/locales/en-US` — English (US) strings
- `@openloomi/i18n/locales/zh-Hans` — Simplified Chinese strings
