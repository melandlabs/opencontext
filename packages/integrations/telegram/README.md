# @openloomi/integrations-telegram

[Telegram](https://telegram.org/) integration for OpenLoomi, powered by the
[`telegram`](https://www.npmjs.com/package/telegram) (MTProto) client.
Includes channel adapter, markdown rendering, conversation store, state
container, and TData decryption / conversion helpers.

## Installation

```sh
pnpm add @openloomi/integrations-telegram
```

## Subpath Exports

- `@openloomi/integrations-telegram` — Main entrypoint
- `@openloomi/integrations-telegram/adapter` — `TelegramAdapter`
- `@openloomi/integrations-telegram/markdown` — Markdown ↔ Telegram entity
  converter
- `@openloomi/integrations-telegram/conversation-store` — Conversation
  persistence
- `@openloomi/integrations-telegram/state` — Runtime state container
- `@openloomi/integrations-telegram/tdata-decrypter` — Decrypt Telegram
  Desktop `tdata` sessions
- `@openloomi/integrations-telegram/tdata-converter` — Convert `tdata` to
  standalone session strings
