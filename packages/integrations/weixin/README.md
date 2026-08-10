# integrations-weixin (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


[WeChat](https://www.wechat.com/) (微信) integration for OpenContext. Built on
the official
[`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
SDK and ships helpers for QR login, CDN asset decryption, and iLink
reverse-engineered listeners.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `integrations-weixin` — Main entrypoint
- `integrations-weixin/ws-listener` — WebSocket listener for the
  iLink client
- `integrations-weixin/conversation-store` — Conversation
  persistence
- `integrations-weixin/ilink-client` — iLink protocol client
- `integrations-weixin/cdn/aes-ecb` — AES-ECB decryption helper
- `integrations-weixin/cdn/cdn-upload` — CDN upload helper
- `integrations-weixin/cdn/cdn-url` — CDN URL signing helper
- `integrations-weixin/cdn/pic-decrypt` — Decrypt CDN-hosted
  pictures
- `integrations-weixin/qr-login` — QR-code login flow
