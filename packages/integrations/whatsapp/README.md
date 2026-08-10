# integrations-whatsapp (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


[WhatsApp](https://www.whatsapp.com/) integration for OpenContext, powered by
[`@whiskeysockets/baileys`](https://www.npmjs.com/package/@whiskeysockets/baileys)
(a WebSocket-based multi-device client). Includes channel adapter,
conversation store, markdown renderer, and a multi-account client registry.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `integrations-whatsapp` — Main entrypoint
- `integrations-whatsapp/conversation-store` — Conversation
  persistence
- `integrations-whatsapp/markdown` — Markdown ↔ WhatsApp message
  converter
- `integrations-whatsapp/client-registry` — Multi-account client
  registry
