# integrations-telegram (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


[Telegram](https://telegram.org/) integration for OpenContext, powered by the
[`telegram`](https://www.npmjs.com/package/telegram) (MTProto) client.
Includes channel adapter, markdown rendering, conversation store, state
container, and TData decryption / conversion helpers.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `integrations-telegram` — Main entrypoint
- `integrations-telegram/adapter` — `TelegramAdapter`
- `integrations-telegram/markdown` — Markdown ↔ Telegram entity
  converter
- `integrations-telegram/conversation-store` — Conversation
  persistence
- `integrations-telegram/state` — Runtime state container
- `integrations-telegram/tdata-decrypter` — Decrypt Telegram
  Desktop `tdata` sessions
- `integrations-telegram/tdata-converter` — Convert `tdata` to
  standalone session strings
