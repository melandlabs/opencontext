# @opencontext/integrations-telegram

[Telegram](https://telegram.org/) integration for OpenContext, powered by the
[`telegram`](https://www.npmjs.com/package/telegram) (MTProto) client.
Includes channel adapter, markdown rendering, conversation store, state
container, and TData decryption / conversion helpers.

## Installation

```sh
pnpm add @opencontext/integrations-telegram
```

## Subpath Exports

- `@opencontext/integrations-telegram` — Main entrypoint
- `@opencontext/integrations-telegram/adapter` — `TelegramAdapter`
- `@opencontext/integrations-telegram/markdown` — Markdown ↔ Telegram entity
  converter
- `@opencontext/integrations-telegram/conversation-store` — Conversation
  persistence
- `@opencontext/integrations-telegram/state` — Runtime state container
- `@opencontext/integrations-telegram/tdata-decrypter` — Decrypt Telegram
  Desktop `tdata` sessions
- `@opencontext/integrations-telegram/tdata-converter` — Convert `tdata` to
  standalone session strings
