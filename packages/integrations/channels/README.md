# @opencontext/integrations-channels

Multi-channel integration framework for OpenContext. Provides the shared
`Channel`, `Platform`, and `ExtractedMessageInfo` types, plus re-exports of
per-platform adapters (Telegram, WhatsApp, WeChat, DingTalk, Feishu, QQ Bot,
Discord, Gmail, iMessage, Docs, HubSpot).

## Installation

```sh
pnpm add @opencontext/integrations-channels
```

## Subpath Exports

- `@opencontext/integrations-channels` — Main entrypoint
- `@opencontext/integrations-channels/telegram` — Telegram adapter
- `@opencontext/integrations-channels/whatsapp` — WhatsApp adapter
- `@opencontext/integrations-channels/weixin` — WeChat adapter
- `@opencontext/integrations-channels/dingtalk` — DingTalk adapter
- `@opencontext/integrations-channels/feishu` — Feishu (Lark) adapter
- `@opencontext/integrations-channels/qqbot` — QQ Bot adapter
- `@opencontext/integrations-channels/discord` — Discord adapter
- `@opencontext/integrations-channels/gmail` — Gmail adapter
- `@opencontext/integrations-channels/imessage` — iMessage adapter
- `@opencontext/integrations-channels/docs` — Google Docs adapter
- `@opencontext/integrations-channels/hubspot` — HubSpot adapter
- `@opencontext/integrations-channels/sources/types` — Shared source types
