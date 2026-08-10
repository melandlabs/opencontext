# @opencontext/integrations-whatsapp

[WhatsApp](https://www.whatsapp.com/) integration for OpenContext, powered by
[`@whiskeysockets/baileys`](https://www.npmjs.com/package/@whiskeysockets/baileys)
(a WebSocket-based multi-device client). Includes channel adapter,
conversation store, markdown renderer, and a multi-account client registry.

## Installation

```sh
pnpm add @opencontext/integrations-whatsapp
```

## Subpath Exports

- `@opencontext/integrations-whatsapp` — Main entrypoint
- `@opencontext/integrations-whatsapp/conversation-store` — Conversation
  persistence
- `@opencontext/integrations-whatsapp/markdown` — Markdown ↔ WhatsApp message
  converter
- `@opencontext/integrations-whatsapp/client-registry` — Multi-account client
  registry
