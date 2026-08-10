# @openloomi/integrations-channels

Multi-channel integration framework for OpenLoomi. Provides the shared
`Channel`, `Platform`, and `ExtractedMessageInfo` types, plus re-exports of
per-platform adapters (Telegram, WhatsApp, WeChat, DingTalk, Feishu, QQ Bot,
Discord, Gmail, iMessage, Docs, HubSpot).

## Installation

```sh
pnpm add @openloomi/integrations-channels
```

## Subpath Exports

- `@openloomi/integrations-channels` — Main entrypoint
- `@openloomi/integrations-channels/telegram` — Telegram adapter
- `@openloomi/integrations-channels/whatsapp` — WhatsApp adapter
- `@openloomi/integrations-channels/weixin` — WeChat adapter
- `@openloomi/integrations-channels/dingtalk` — DingTalk adapter
- `@openloomi/integrations-channels/feishu` — Feishu (Lark) adapter
- `@openloomi/integrations-channels/qqbot` — QQ Bot adapter
- `@openloomi/integrations-channels/discord` — Discord adapter
- `@openloomi/integrations-channels/gmail` — Gmail adapter
- `@openloomi/integrations-channels/imessage` — iMessage adapter
- `@openloomi/integrations-channels/docs` — Google Docs adapter
- `@openloomi/integrations-channels/hubspot` — HubSpot adapter
- `@openloomi/integrations-channels/sources/types` — Shared source types
