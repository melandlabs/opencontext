# @openloomi/integrations-whatsapp

[WhatsApp](https://www.whatsapp.com/) integration for OpenLoomi, powered by
[`@whiskeysockets/baileys`](https://www.npmjs.com/package/@whiskeysockets/baileys)
(a WebSocket-based multi-device client). Includes channel adapter,
conversation store, markdown renderer, and a multi-account client registry.

## Installation

```sh
pnpm add @openloomi/integrations-whatsapp
```

## Subpath Exports

- `@openloomi/integrations-whatsapp` — Main entrypoint
- `@openloomi/integrations-whatsapp/conversation-store` — Conversation
  persistence
- `@openloomi/integrations-whatsapp/markdown` — Markdown ↔ WhatsApp message
  converter
- `@openloomi/integrations-whatsapp/client-registry` — Multi-account client
  registry
