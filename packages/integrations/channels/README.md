# integrations-channels (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


Multi-channel integration framework for OpenContext. Provides the shared
`Channel`, `Platform`, and `ExtractedMessageInfo` types, plus re-exports of
per-platform adapters (Telegram, WhatsApp, WeChat, DingTalk, Feishu, QQ Bot,
Discord, Gmail, iMessage, Docs, HubSpot).

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `integrations-channels` — Main entrypoint
- `integrations-channels/telegram` — Telegram adapter
- `integrations-channels/whatsapp` — WhatsApp adapter
- `integrations-channels/weixin` — WeChat adapter
- `integrations-channels/dingtalk` — DingTalk adapter
- `integrations-channels/feishu` — Feishu (Lark) adapter
- `integrations-channels/qqbot` — QQ Bot adapter
- `integrations-channels/discord` — Discord adapter
- `integrations-channels/gmail` — Gmail adapter
- `integrations-channels/imessage` — iMessage adapter
- `integrations-channels/docs` — Google Docs adapter
- `integrations-channels/hubspot` — HubSpot adapter
- `integrations-channels/sources/types` — Shared source types
